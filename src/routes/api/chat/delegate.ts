import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";

/**
 * POST /api/chat/delegate — the chat assistant asks for a session for a person
 * it has identified. See `src/lib/chat/delegate.ts` for what that does and does
 * not grant.
 *
 * Not under `/api/auth/`: that prefix is Better Auth's own surface.
 *
 * The caller is authenticated by the assertion alone: signed with
 * `CHAT_BRIDGE_SECRET`, for this audience, unexpired, and not seen before.
 * Without the secret configured the route does not exist.
 */
let replayGuard: import("@/lib/chat/statement").ReplayGuard | null = null;

const refused = (status: number, message: string) =>
  json({ success: false, error: { code: "REFUSED", message } }, { status });

export const Route = createFileRoute("/api/chat/delegate")({
  server: {
    handlers: {
      POST: withApiHandler("/api/chat/delegate", async ({ request }) => {
        const { chatBridgeSecret, verifyStatement, ReplayGuard } = await import("@/lib/chat/statement");
        const secret = chatBridgeSecret();
        if (!secret) return refused(404, "Not found");

        const body = (await request.json().catch(() => null)) as { assertion?: unknown } | null;
        const assertion = typeof body?.assertion === "string" ? body.assertion : null;
        const claims = await verifyStatement(secret, assertion, "report-delegate");
        if (!claims) return refused(401, "The assertion was not accepted.");

        replayGuard ??= new ReplayGuard();
        if (!replayGuard.accept(claims.jti, claims.exp)) return refused(401, "The assertion was not accepted.");

        const { personFrom, syncDelegatedUser, DelegationRefused } = await import("@/lib/chat/delegate");
        const person = personFrom(claims);
        if (!person) return refused(400, "The assertion names nobody.");

        const { getDb } = await import("@/lib/db/config");
        const { getAuth } = await import("@/lib/auth/better-auth");
        const { logAudit } = await import("@/lib/security/audit");

        let synced: Awaited<ReturnType<typeof syncDelegatedUser>>;
        try {
          synced = await syncDelegatedUser(getDb(), person);
        } catch (error) {
          if (error instanceof DelegationRefused) return refused(403, error.message);
          throw error;
        }

        // Better Auth creates the session and names the cookie; the value is signed the way it signs its own.
        const context = await getAuth().$context;
        const session = await context.internalAdapter.createSession(synced.userId);
        if (!session) return refused(500, "The session could not be created.");
        const cookie = context.authCookies.sessionToken;
        const { signedSessionCookie } = await import("@/lib/chat/session-cookie");
        const setCookie = await signedSessionCookie(cookie.name, session.token, context.secret, cookie.attributes);

        logAudit({
          userId: synced.userId,
          action: "chat:delegated_sign_in",
          resourceType: "user",
          resourceId: synced.userId,
          details: { roles: synced.roles, created: synced.created, admin: person.admin },
        }).catch(() => undefined);

        return json({
          success: true,
          setCookie: [setCookie],
          expiresAt: new Date(session.expiresAt).getTime(),
        });
      }),
    },
  },
});
