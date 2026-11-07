import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import {
  refuseUnlessOwnerOrAdmin,
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/reports/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/reports/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "report", "view");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();
          const report = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!report) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }

          return json({ success: true, data: report });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch report");
        }
      }),

      PUT: withApiHandler("/api/reports/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "report", "edit");
          if (denied) return denied;

          const { id } = params;
          const body = await request.json();
          const {
            name,
            description,
            savedQueryId,
            columnConfig,
            filterConfig,
            sortConfig,
            paginationConfig,
            exportFormats,
            filenameTemplate,
            colorTheme,
          } = body;

          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("report_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "report");
          if (notYours) return notYours;
          const existing = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }

          await db
            .updateTable("report_definitions")
            .set({
              name: name ?? existing.name,
              description: description !== undefined ? description : existing.description,
              saved_query_id: savedQueryId !== undefined ? savedQueryId : existing.saved_query_id,
              column_config: columnConfig ? JSON.stringify(columnConfig) : existing.column_config,
              filter_config: filterConfig ? JSON.stringify(filterConfig) : existing.filter_config,
              sort_config: sortConfig ? JSON.stringify(sortConfig) : existing.sort_config,
              pagination_config: paginationConfig
                ? JSON.stringify(paginationConfig)
                : existing.pagination_config,
              export_formats: exportFormats
                ? JSON.stringify(exportFormats)
                : existing.export_formats,
              filename_template: filenameTemplate
                ? JSON.stringify(filenameTemplate)
                : existing.filename_template,
              color_theme: colorTheme ? JSON.stringify(colorTheme) : existing.color_theme,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", id)
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "report",
            resourceId: id,
          });

          const report = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();
          return json({ success: true, data: report });
        } catch (error) {
          throw serverFailure(error, "Failed to update report");
        }
      }),

      PATCH: withApiHandler("/api/reports/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "report", "edit");
          if (denied) return denied;

          const { id } = params;
          const body = await request.json();
          const { colorTheme } = body;

          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("report_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "report");
          if (notYours) return notYours;
          const existing = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }

          const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (colorTheme !== undefined) {
            updateData.color_theme = JSON.stringify(colorTheme);
          }

          await db.updateTable("report_definitions").set(updateData).where("id", "=", id).execute();

          await logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "report",
            resourceId: id,
          });

          const report = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();
          return json({ success: true, data: report });
        } catch (error) {
          throw serverFailure(error, "Failed to update report");
        }
      }),

      DELETE: withApiHandler("/api/reports/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "report", "delete");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("report_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "report");
          if (notYours) return notYours;

          await db.deleteFrom("report_definitions").where("id", "=", id).execute();

          await logAudit({
            userId: session.user.id,
            action: "delete",
            resourceType: "report",
            resourceId: id,
          });

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete report");
        }
      }),
    },
  },
});
