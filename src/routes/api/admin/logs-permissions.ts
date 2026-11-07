import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { json } from "@/lib/server/response";
import { isAdmin } from "@/lib/permissions/permissions";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/admin/logs-permissions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/admin/logs-permissions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          const db = getDb();
          const setting = await db
            .selectFrom("app_settings")
            .selectAll()
            .where("key", "=", "logs_visible_to_users")
            .executeTakeFirst();

          return json({
            success: true,
            data: {
              logsVisibleToUsers: setting?.value === "true" || true,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),

      PUT: withApiHandler("/api/admin/logs-permissions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          const body = (await request.json()) as {
            logsVisibleToUsers: boolean;
          };

          const db = getDb();

          await db.deleteFrom("app_settings").where("key", "=", "logs_visible_to_users").execute();

          await db
            .insertInto("app_settings")
            .values({
              key: "logs_visible_to_users",
              value: body.logsVisibleToUsers ? "true" : "false",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .execute();

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),
    },
  },
});
