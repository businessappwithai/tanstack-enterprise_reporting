/**
 * A session for a person the chat assistant has already identified.
 *
 * The generated application and this platform keep separate accounts, on
 * purpose (a role there decides what you may do to a record; a role here
 * decides which tables your queries may read). A person who works through the
 * chat signs in once, to the application. For them to open a report, this
 * platform has to be told who they are by something it trusts — the assistant,
 * holding `CHAT_BRIDGE_SECRET` — and then decide for itself what they may read.
 *
 * So the assistant supplies identity and nothing else:
 *
 *  - the person is created here on first use, with no password (they cannot
 *    sign in directly; the per-role demo accounts are unaffected);
 *  - their roles here are the reporting roles whose names match their
 *    application roles — the ones `seed-reporting-pack.ts` wrote from the same
 *    `%%rbac` — and are re-synced on every delegation, so a role taken away in
 *    the application is gone here at the next one;
 *  - they are an administrator here only when the application says they are
 *    one there. A role *named* "admin" in a model never grants it;
 *  - an account that already exists here **with a password of its own** is a
 *    local account, managed here. The assistant never changes its roles, and
 *    signs in as it only for an application administrator — the one address
 *    both sides create for themselves (`admin@admin.com`). For anyone else a
 *    matching address is a coincidence the assistant must not turn into
 *    somebody's access, in either direction.
 *
 * Every query they then run goes through `decideQueryRun` like anyone's.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "@/lib/db/kysely-db";
import { roleKey, type Statement } from "./statement";

export interface DelegatedPerson {
  email: string;
  name: string;
  roles: string[];
  admin: boolean;
}

export function personFrom(claims: Statement): DelegatedPerson | null {
  const email = claims.sub.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role): role is string => typeof role === "string").slice(0, 50)
    : [];
  return {
    email,
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 120) : email,
    roles,
    admin: claims.admin === true,
  };
}

export interface SyncResult {
  userId: string;
  created: boolean;
  roles: string[];
}

/** Create the person if needed and make their roles here match their application roles. */
export async function syncDelegatedUser(db: Kysely<Database>, person: DelegatedPerson): Promise<SyncResult> {
  const now = new Date().toISOString();
  const wanted = new Set(person.roles.map(roleKey));

  return db.transaction().execute(async (trx) => {
    let user = await trx
      .selectFrom("users")
      .select(["id", "is_active"])
      .where("email", "=", person.email)
      .executeTakeFirst();
    let created = false;

    if (!user) {
      const id = randomUUID().replace(/-/g, "");
      await trx
        .insertInto("users")
        .values({
          id,
          email: person.email,
          password_hash: null,
          display_name: person.name,
          avatar_url: null,
          is_active: true,
          created_at: now,
          updated_at: now,
        } as never)
        .execute();
      user = { id, is_active: true };
      created = true;
    } else if (!user.is_active) {
      // Deactivated here by an administrator: the assistant does not get to undo that.
      throw new DelegationRefused("This account is deactivated in the reporting platform.");
    } else if (await hasOwnPassword(trx, user.id)) {
      // A local account. Re-syncing would strip roles an administrator granted
      // here — an Administrator whose application account is ordinary would lose
      // the role at their first chat sign-in — and signing an ordinary
      // application user in as it would hand them whatever it holds.
      if (!person.admin) {
        throw new DelegationRefused(
          "This address has its own account in the reporting platform. Sign in there directly."
        );
      }
      const held = await trx
        .selectFrom("user_roles")
        .innerJoin("roles", "roles.id", "user_roles.role_id")
        .select("roles.name")
        .where("user_roles.user_id", "=", user.id)
        .execute();
      return { userId: user.id, created: false, roles: held.map((role) => role.name) };
    }

    const allRoles = await trx.selectFrom("roles").select(["id", "name"]).execute();
    const adminRole = allRoles.find((role) => role.name.toLowerCase() === "admin" || role.name === "Administrator");
    const matched = allRoles.filter(
      (role) => role.id !== adminRole?.id && !isPlatformAdminName(role.name) && wanted.has(roleKey(role.name))
    );
    const target = new Map(matched.map((role) => [role.id, role.name]));
    if (person.admin && adminRole) target.set(adminRole.id, adminRole.name);

    await trx.deleteFrom("user_roles").where("user_id", "=", user.id).execute();
    if (target.size > 0) {
      await trx
        .insertInto("user_roles")
        .values([...target.keys()].map((roleId) => ({ user_id: user.id, role_id: roleId, assigned_at: now })))
        .execute();
    }

    // The per-data-source roles carry the table permissions; same names, same rule.
    const dsRoles = await trx.selectFrom("ds_roles").select(["id", "data_source_id", "name"]).execute();
    await trx.deleteFrom("ds_user_roles").where("user_id", "=", user.id).execute();
    const dsMatched = dsRoles.filter((role) => wanted.has(roleKey(role.name)));
    if (dsMatched.length > 0) {
      await trx
        .insertInto("ds_user_roles")
        .values(
          dsMatched.map((role) => ({
            data_source_id: role.data_source_id,
            user_id: user.id,
            ds_role_id: role.id,
            assigned_at: now,
          }))
        )
        .execute();
    }

    return { userId: user.id, created, roles: [...target.values()] };
  });
}

/**
 * True for an account that can sign in here by itself: a credential Better
 * Auth holds, or the legacy hash on the user row that bootstrap copies across.
 * Accounts the assistant created have neither.
 */
async function hasOwnPassword(trx: Kysely<Database>, userId: string): Promise<boolean> {
  const user = await trx.selectFrom("users").select("password_hash").where("id", "=", userId).executeTakeFirst();
  if (user?.password_hash) return true;
  const credential = await trx
    .selectFrom("auth_accounts")
    .select("id")
    .where("user_id", "=", userId)
    .where("provider_id", "=", "credential")
    .where("password", "is not", null)
    .executeTakeFirst();
  return credential !== undefined;
}

/**
 * Role names this platform treats as administrator. `resource-guard.ts` reads
 * any role whose name *contains* "admin" as one, so a model role called
 * "Office Administrator" — or the seeder's "Administrator (model role)" — must
 * never be handed out by matching names. Administrator comes from the
 * application's own verdict (`person.admin`) and from nothing else.
 */
function isPlatformAdminName(name: string): boolean {
  return name.toLowerCase().includes("admin");
}

export class DelegationRefused extends Error {}
