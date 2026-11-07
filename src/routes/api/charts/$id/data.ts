import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql as kyselySql } from "kysely";
import { json } from "@/lib/server/response";
import {
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { decideQueryRun } from "@/lib/permissions/runnable-query";
import type { DataSource } from "@/types/database";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/charts/$id/data")({
  server: {
    handlers: {
      GET: withApiHandler("/api/charts/$id/data", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "view");
          if (denied) return denied;

          const { id: chartId } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          const chart = await db
            .selectFrom("chart_definitions")
            .selectAll()
            .where("id", "=", chartId)
            .executeTakeFirst();

          if (!chart) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }

          if (!chart.saved_query_id) {
            return json({
              success: true,
              data: { rows: [], totalRows: 0, pageIndex: 0, pageSize: 1000 },
            });
          }

          const savedQuery = await db
            .selectFrom("saved_queries")
            .selectAll()
            .where("id", "=", chart.saved_query_id)
            .executeTakeFirst();

          if (!savedQuery) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Saved query not found" } },
              { status: 404 }
            );
          }

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", savedQuery.data_source_id)
            .where("is_active", "=", true)
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              {
                success: false,
                error: { code: "NOT_FOUND", message: "Data source not found or inactive" },
              },
              { status: 404 }
            );
          }

          // May this caller run this stored SQL, and is it safe to run? See
          // src/lib/permissions/runnable-query.ts — this route used to ask
          // neither question, so any signed-in user could read any chart's data.
          const decision = await decideQueryRun(
            session.user,
            savedQuery.sql_content,
            savedQuery.data_source_id
          );
          if (!decision.ok) {
            return json(
              { success: false, error: { code: decision.code, message: decision.message } },
              { status: decision.status }
            );
          }

          const { getConnection } = await import("@/lib/db/connection-manager");
          const connection = await getConnection(dataSource as unknown as DataSource);

          const url = new URL(request.url);
          const pageSize = parseInt(url.searchParams.get("pageSize") || "1000");

          const rawSql = savedQuery.sql_content.trim().replace(/;$/, "");
          const limitedSql = /\bLIMIT\s+\d+/i.test(rawSql) ? rawSql : `${rawSql} LIMIT ${pageSize}`;

          const { rows } = await kyselySql.raw(limitedSql).execute(connection);
          const typedRows = rows as Record<string, unknown>[];

          return json({
            success: true,
            data: {
              rows: typedRows,
              totalRows: typedRows.length,
              pageIndex: 0,
              pageSize,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch chart data");
        }
      }),
    },
  },
});
