import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { isAdmin } from "@/lib/permissions/permissions";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/admin/users")({
  server: {
    handlers: {
      GET: withApiHandler("/api/admin/users", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          /*
           * Named columns, not `selectAll()`.
           *
           * `users` carries `password_hash` — a legacy bcrypt credential that
           * Better Auth no longer reads but that is still populated for every
           * account predating the migration. This route selected the whole row
           * behind a session check alone, so any authenticated user could
           * retrieve every account's hash and attack them offline.
           *
           * The administrator check above fixes who may call this. Listing the
           * columns fixes what it can ever return, which is the half that
           * survives somebody adding a second caller: a screen listing users
           * has no use for a credential, and the safest way to keep one out of
           * a response is for the query never to ask for it.
           */
          const db = getDb();
          const users = await db
            .selectFrom("users")
            .select([
              "id",
              "email",
              "display_name",
              "avatar_url",
              "email_verified",
              "is_active",
              "created_at",
              "updated_at",
            ])
            .orderBy("created_at", "desc")
            .execute();

          /*
           * Each user's roles, because the Users page needs them for two things.
           *
           * It shows them, and it builds the request for "assign" and "remove" from them:
           * `updateUser` REPLACES a user's whole role set, so the page sends
           * `[...currentRoleIds, newRoleId]`. This route returned no roles, so
           * `currentRoleIds` was always empty — assigning one role silently stripped every
           * other role the user had (including an administrator's own), and removing any
           * role removed all of them. The contract was already declared by `UserWithRoles`.
           */
          const roleRows = await db
            .selectFrom("user_roles")
            .innerJoin("roles", "roles.id", "user_roles.role_id")
            .select(["user_roles.user_id as user_id", "roles.id as role_id", "roles.name as role_name"])
            .orderBy("roles.name")
            .execute();
          const rolesByUser = new Map<string, { id: string; name: string }[]>();
          for (const row of roleRows) {
            const list = rolesByUser.get(row.user_id) ?? [];
            list.push({ id: row.role_id, name: row.role_name });
            rolesByUser.set(row.user_id, list);
          }

          return json({
            success: true,
            data: users.map((u) => ({ ...u, roles: rolesByUser.get(u.id) ?? [] })),
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch users");
        }
      }),
    },
  },
});
