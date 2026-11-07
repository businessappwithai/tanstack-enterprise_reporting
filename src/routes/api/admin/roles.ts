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

export const Route = createFileRoute("/api/admin/roles")({
  server: {
    handlers: {
      GET: withApiHandler("/api/admin/roles", async ({ request }) => {
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

          const db = getDb();
          const roles = await db.selectFrom("roles").selectAll().execute();

          return json({ success: true, data: roles });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch roles");
        }
      }),
    },
  },
});
