import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { canConfigureReport } from "@/lib/permissions/report-ownership";

async function getSession(_request: Request) {
  const { getAuthSession } = await import("@/lib/auth/config");
  return getAuthSession();
}

export const Route = createFileRoute("/api/reports/$id/filters/$filterLinkId")({
  server: {
    handlers: {
      PUT: withApiHandler("/api/reports/$id/filters/$filterLinkId", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session) {
            return json({ error: "Unauthorized" }, { status: 401 });
          }

          // Both verbs here change a report's filters, and a filter decides
          // which rows the report returns. See report-ownership.ts — this route
          // used to resolve the report by id alone and let any signed-in caller
          // rewrite or remove somebody else's.
          const ownership = await canConfigureReport(session.user.id, params.id);
          if (!ownership.allowed) {
            return json({ error: ownership.message }, { status: ownership.status ?? 403 });
          }

          const body = await request.json();
          const { target_column, filter_order } = body;

          const updateData: Record<string, unknown> = {};
          if (target_column !== undefined) updateData.target_column = target_column;
          if (filter_order !== undefined) updateData.filter_order = filter_order;

          const { id: reportId, filterLinkId } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          // Check existence first
          const existing = await db
            .selectFrom("report_filters")
            .select("id")
            .where("id", "=", filterLinkId)
            .where("report_id", "=", reportId)
            .executeTakeFirst();

          if (!existing) {
            return json({ error: "Report filter not found" }, { status: 404 });
          }

          await db
            .updateTable("report_filters")
            .set(updateData)
            .where("id", "=", filterLinkId)
            .where("report_id", "=", reportId)
            .execute();

          return json({ success: true });
        } catch (error) {
          recordFailure(error, "Error updating report filter:");
          return json({ error: "Failed to update report filter" }, { status: 500 });
        }
      }),

      DELETE: withApiHandler("/api/reports/$id/filters/$filterLinkId", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session) {
            return json({ error: "Unauthorized" }, { status: 401 });
          }

          // Both verbs here change a report's filters, and a filter decides
          // which rows the report returns. See report-ownership.ts — this route
          // used to resolve the report by id alone and let any signed-in caller
          // rewrite or remove somebody else's.
          const ownership = await canConfigureReport(session.user.id, params.id);
          if (!ownership.allowed) {
            return json({ error: ownership.message }, { status: ownership.status ?? 403 });
          }

          const { id: reportId, filterLinkId } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          // Check existence first
          const existing = await db
            .selectFrom("report_filters")
            .select("id")
            .where("id", "=", filterLinkId)
            .where("report_id", "=", reportId)
            .executeTakeFirst();

          if (!existing) {
            return json({ error: "Report filter not found" }, { status: 404 });
          }

          await db
            .deleteFrom("report_filters")
            .where("id", "=", filterLinkId)
            .where("report_id", "=", reportId)
            .execute();

          return json({ success: true });
        } catch (error) {
          recordFailure(error, "Error deleting report filter:");
          return json({ error: "Failed to delete report filter" }, { status: 500 });
        }
      }),
    },
  },
});
