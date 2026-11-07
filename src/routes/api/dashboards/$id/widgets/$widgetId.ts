import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import {
  refuseWithoutPermission,
  refuseUnlessOwnerOrAdmin,
} from "@/lib/permissions/resource-guard";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/dashboards/$id/widgets/$widgetId")({
  server: {
    handlers: {
      DELETE: withApiHandler("/api/dashboards/$id/widgets/$widgetId", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "edit");
          if (denied) return denied;

          const { getDb: getParentDb } = await import("@/lib/db/config");
          const parent = await getParentDb()
            .selectFrom("dashboard_layouts")
            .select("created_by")
            .where("id", "=", params.id)
            .executeTakeFirst();
          if (!parent) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, parent.created_by, "dashboard");
          if (notYours) return notYours;

          const { id, widgetId } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          const widget = await db
            .selectFrom("dashboard_widgets")
            .select("id")
            .where("id", "=", widgetId)
            .where("dashboard_id", "=", id)
            .executeTakeFirst();

          if (!widget) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Widget not found" } },
              { status: 404 }
            );
          }

          await db
            .deleteFrom("dashboard_widgets")
            .where("id", "=", widgetId)
            .where("dashboard_id", "=", id)
            .execute();

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete widget");
        }
      }),

      PUT: withApiHandler("/api/dashboards/$id/widgets/$widgetId", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "edit");
          if (denied) return denied;

          const { getDb: getParentDb } = await import("@/lib/db/config");
          const parent = await getParentDb()
            .selectFrom("dashboard_layouts")
            .select("created_by")
            .where("id", "=", params.id)
            .executeTakeFirst();
          if (!parent) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, parent.created_by, "dashboard");
          if (notYours) return notYours;

          const { id, widgetId } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          const widget = await db
            .selectFrom("dashboard_widgets")
            .select("id")
            .where("id", "=", widgetId)
            .where("dashboard_id", "=", id)
            .executeTakeFirst();

          if (!widget) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Widget not found" } },
              { status: 404 }
            );
          }

          const body = await request.json();
          const { positionConfig, widgetConfig } = body;

          await db
            .updateTable("dashboard_widgets")
            .set({
              ...(positionConfig !== undefined && {
                position_config: JSON.stringify(positionConfig),
              }),
              ...(widgetConfig !== undefined && {
                widget_config: widgetConfig ? JSON.stringify(widgetConfig) : null,
              }),
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", widgetId)
            .where("dashboard_id", "=", id)
            .execute();

          const updated = await db
            .selectFrom("dashboard_widgets")
            .selectAll()
            .where("id", "=", widgetId)
            .executeTakeFirst();

          return json({ success: true, data: updated });
        } catch (error) {
          throw serverFailure(error, "Failed to update widget");
        }
      }),
    },
  },
});
