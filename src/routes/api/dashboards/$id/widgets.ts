import { randomUUID } from "node:crypto";
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

export const Route = createFileRoute("/api/dashboards/$id/widgets")({
  server: {
    handlers: {
      GET: withApiHandler("/api/dashboards/$id/widgets", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "view");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          // Verify dashboard exists
          const dashboard = await db
            .selectFrom("dashboard_layouts")
            .select("id")
            .where("id", "=", id)
            .executeTakeFirst();

          if (!dashboard) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }

          const widgets = await db
            .selectFrom("dashboard_widgets")
            .selectAll()
            .where("dashboard_id", "=", id)
            .execute();

          return json({ success: true, data: { items: widgets } });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch dashboard widgets");
        }
      }),

      POST: withApiHandler("/api/dashboards/$id/widgets", async ({ request, params }) => {
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

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          // Verify dashboard exists
          const dashboard = await db
            .selectFrom("dashboard_layouts")
            .select("id")
            .where("id", "=", id)
            .executeTakeFirst();

          if (!dashboard) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }

          const body = await request.json();
          const { widgetType, reportId, chartId, positionConfig, widgetConfig } = body;

          if (!widgetType) {
            return json(
              {
                success: false,
                error: { code: "VALIDATION_ERROR", message: "widgetType is required" },
              },
              { status: 400 }
            );
          }

          const now = new Date().toISOString();
          const widgetId = randomUUID();

          await db
            .insertInto("dashboard_widgets")
            .values({
              id: widgetId,
              dashboard_id: id,
              widget_type: widgetType,
              report_id: reportId ?? null,
              chart_id: chartId ?? null,
              position_config: JSON.stringify(positionConfig ?? {}),
              widget_config: widgetConfig ? JSON.stringify(widgetConfig) : null,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const widget = await db
            .selectFrom("dashboard_widgets")
            .selectAll()
            .where("id", "=", widgetId)
            .executeTakeFirst();

          return json({ success: true, data: widget }, { status: 201 });
        } catch (error) {
          throw serverFailure(error, "Failed to add widget");
        }
      }),
    },
  },
});
