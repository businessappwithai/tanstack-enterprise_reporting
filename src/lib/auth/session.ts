/**
 * The session seam.
 *
 * Authentication is Better Auth now (src/lib/auth/better-auth.ts), but the
 * shapes below are unchanged: `Session`, `SessionUser`, and a `verifySession`
 * that takes a token. Roughly fifty call sites across the API routes and server
 * functions depend on them, and none of those files care which library issues
 * the cookie — so the library moved and the seam did not.
 *
 * What DID change is where roles and permissions come from. The old
 * implementation baked them into an HS256 JWT at sign-in, so a role revoked at
 * 09:00 was still granted by an unexpired token at 17:00. They are now read
 * from `roles`/`user_roles` on every request, against the session's user id.
 * That is a live check: revocation takes effect on the next request.
 */

import { getDb } from "@/lib/db/config";
import { getAuth, SESSION_COOKIE_NAME } from "./better-auth";
import { SESSION_UNAVAILABLE_MESSAGE } from "./session-errors";
import { getLogger } from "@/lib/logging/logger";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export interface Session {
  user: SessionUser;
  expires: string;
}

/**
 * Resolve a user's roles and the permissions those roles carry.
 *
 * `roles.permissions` is a JSON array of `resource:action` strings. A row whose
 * JSON does not parse contributes nothing rather than throwing — one malformed
 * role must not lock every one of its members out of the application.
 */
export async function loadRolesAndPermissions(
  userId: string
): Promise<{ roles: string[]; permissions: string[] }> {
  const db = getDb();
  const roles = await db
    .selectFrom("roles")
    .innerJoin("user_roles", "roles.id", "user_roles.role_id")
    .where("user_roles.user_id", "=", userId)
    .selectAll("roles")
    .execute();

  const permissions = roles.flatMap((role: { permissions: string }) => {
    try {
      const parsed = JSON.parse(role.permissions);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  });

  return {
    roles: roles.map((r: { name: string }) => r.name),
    permissions: Array.from(new Set(permissions)),
  };
}

/**
 * Pull this application's session token out of a Cookie header.
 *
 * The name has to be matched whole, at a cookie boundary. Every caller used to
 * run `cookie.match(/session_token=([^;]+)/)`, which is unanchored: it finds
 * the first *substring* `session_token=` anywhere in the header. That is
 * correct exactly until something else on the same origin sets a cookie whose
 * name ends the same way — and the generated application does, as
 * `<project>_app.session_token`, because Better Auth cookies are path `/` and
 * nginx serves both applications from one origin.
 *
 * The browser then sends both, alphabetically, so `crm_app.session_token`
 * arrives first; the old regex captured *its* value, handed the generated
 * application's token to `verifySession`, found no such row here, and returned
 * null. Signed in, session valid, and every permission gone: the reporting
 * dashboard rendered "0 of 10 modules available" to a full administrator.
 *
 * `SESSION_COOKIE_NAME` is the constant Better Auth is configured with, so this
 * cannot drift from what is actually set.
 */
export function readSessionToken(cookieHeader: string): string | null {
  if (!cookieHeader) return null;
  const name = SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] || null;
}

/**
 * The session could not be checked — the database (or Better Auth's view of it) failed.
 *
 * This is deliberately not `null`. `null` means "signed out" and every caller answers it
 * with a redirect to /login or a 401; an outage answered that way signs out everyone who
 * happens to load a page while the database is restarting, and tells them their
 * password is the problem. Callers that cannot handle it let it propagate, which is a
 * 500 or the route's error page: "could not check", which is what happened.
 */
export class SessionUnavailableError extends Error {
  constructor(cause: unknown) {
    super(SESSION_UNAVAILABLE_MESSAGE, { cause });
    this.name = "SessionUnavailableError";
  }
}

const SESSION_RETRY_DELAY_MS = 200;

/**
 * Run a session lookup, retrying once on a throw — a dropped pooled connection is the
 * common case and the second attempt gets a fresh one — and then surface the failure
 * as `SessionUnavailableError`. A lookup that *returns* null is not retried: that is
 * the answer "no session".
 */
async function lookUpWithOneRetry(
  lookup: () => Promise<Session | null>
): Promise<Session | null> {
  try {
    return await lookup();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
    try {
      return await lookup();
    } catch (e) {
      getLogger("auth").event("auth.check.failed", { what: "Failed to resolve session", err: e });
      throw new SessionUnavailableError(e);
    }
  }
}

async function resolveSession(headers: Headers): Promise<Session | null> {
  const result = await getAuth().api.getSession({ headers });
  if (!result?.user?.id) return null;

  const user = result.user as { id: string; email: string; name?: string | null };
  const { roles, permissions } = await loadRolesAndPermissions(user.id);

  const expiresAt = (result.session as { expiresAt?: Date | string } | undefined)?.expiresAt;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? user.email,
      roles,
      permissions,
    },
    expires: expiresAt ? new Date(expiresAt).toISOString() : new Date().toISOString(),
  };
}

/**
 * Resolve the session for a request, from its cookies.
 *
 * This is the preferred entry point: it hands Better Auth the real headers and
 * lets it do the cookie parsing, rather than a regex over the Cookie header.
 *
 * `null` only when there is no session. Better Auth answers a missing, expired or
 * forged cookie with `null`; it *throws* when it cannot reach the database, and so
 * does the role lookup. A throw becomes `SessionUnavailableError`, not "signed out".
 */
export async function getSessionFromHeaders(headers: Headers): Promise<Session | null> {
  return lookUpWithOneRetry(() => resolveSession(headers));
}

/**
 * Resolve a session from a raw session token.
 *
 * Kept because a number of API routes hold the token rather than the request.
 * Unlike the JWT it replaces, this is a database lookup: the row has to exist
 * and be unexpired, so a signed-out session stops working immediately instead
 * of staying valid until its signature expires.
 *
 * Better Auth stores the cookie as `<token>.<signature>`; only the part before
 * the first dot is the token, so a caller passing the whole cookie value still
 * resolves.
 */
export async function verifySession(token: string): Promise<Session | null> {
  if (!token) return null;
  const bareToken = decodeURIComponent(token).split(".")[0];
  if (!bareToken) return null;

  const lookup = async (): Promise<Session | null> => {
    const db = getDb();
    const row = await db
      .selectFrom("auth_sessions")
      .innerJoin("users", "users.id", "auth_sessions.user_id")
      .where("auth_sessions.token", "=", bareToken)
      .where("users.is_active", "=", true)
      .select([
        "users.id as id",
        "users.email as email",
        "users.display_name as display_name",
        "auth_sessions.expires_at as expires_at",
      ])
      .executeTakeFirst();

    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    const { roles, permissions } = await loadRolesAndPermissions(row.id);
    return {
      user: {
        id: row.id,
        email: row.email,
        name: row.display_name,
        roles,
        permissions,
      },
      expires: new Date(row.expires_at).toISOString(),
    };
  };

  // As getSessionFromHeaders: no row is "signed out", a failed lookup is not.
  return lookUpWithOneRetry(lookup);
}
