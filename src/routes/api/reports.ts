import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/server/response";
import {
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { createReportSchema } from "@/lib/schemas/reports";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/reports")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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

          const { searchParams } = new URL(request.url);
          const page = parseInt(searchParams.get("page") || "0", 10);
          const pageSize = parseInt(searchParams.get("pageSize") || "20", 10);

          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          const reports = await db
            .selectFrom("report_definitions")
            .selectAll()
            .orderBy("created_at", "desc")
            // A tie-breaker: rows seeded together share a timestamp, and without one the order of equal rows
            // is not stable between pages, so offset pagination skips some and repeats others.
            .orderBy("id", "desc")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute();

          const countResult = await db
            .selectFrom("report_definitions")
            .select(db.fn.count<number>("id").as("count"))
            .executeTakeFirstOrThrow();
          const total = Number(countResult.count);

          return json({
            success: true,
            data: {
              items: reports,
              meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
            },
          });
        } catch (error) {
          console.error("Error fetching reports:", error);
          return json(
            { success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch reports" } },
            { status: 500 }
          );
        }
      },

      POST: async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "report", "create");
          if (denied) return denied;

          const body = await request.json();
          const result = await createReportSchema.safeParseAsync(body);

          if (!result.success) {
            return json(
              {
                success: false,
                error: {
                  code: "INVALID_INPUT",
                  message: "Validation failed",
                  details: result.error.flatten(),
                },
              },
              { status: 422 }
            );
          }

          const {
            name,
            description,
            savedQueryId,
            columnConfig,
            filterConfig,
            sortConfig,
            paginationConfig,
            exportFormats,
          } = result.data;

          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const id = randomUUID();
          const now = new Date().toISOString();

          await db
            .insertInto("report_definitions")
            .values({
              id,
              name,
              description: description ?? null,
              saved_query_id: savedQueryId ?? null,
              column_config: JSON.stringify(columnConfig || []),
              filter_config: filterConfig ? JSON.stringify(filterConfig) : null,
              sort_config: sortConfig ? JSON.stringify(sortConfig) : null,
              pagination_config: paginationConfig ? JSON.stringify(paginationConfig) : null,
              export_formats: exportFormats
                ? JSON.stringify(exportFormats)
                : '["csv","xlsx","pdf"]',
              color_theme: null,
              is_public: false,
              is_deleted: false,
              deleted_at: null,
              deleted_by: null,
              created_by: session.user.id,
              created_at: now,
              updated_at: now,
            })
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "create",
            resourceType: "report",
            resourceId: id,
            details: { name },
          });

          const report = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          return json({ success: true, data: report }, { status: 201 });
        } catch (error) {
          console.error("Error creating report:", error);
          return json(
            { success: false, error: { code: "SERVER_ERROR", message: "Failed to create report" } },
            { status: 500 }
          );
        }
      },
    },
  },
});
