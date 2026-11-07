import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql as kyselySql } from "kysely";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import {
  applyRowCap,
  capRowsSql,
  coerceNumericColumns,
  datasetMaxRows,
  describeColumns,
  toArrowRows,
} from "@/lib/datasets/dataset-query";
import { rowsToArrowIPC } from "@/lib/export/arrow-exporter";
import { decideQueryRun } from "@/lib/permissions/runnable-query";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";
import type { DataSource } from "@/types/database";

function fail(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status });
}

export const Route = createFileRoute("/api/datasets/$id/data")({
  server: {
    handlers: {
      // Runs the dataset's saved query and returns the rows as an Arrow IPC stream, which
      // the browser hands to DuckDB-WASM. The query runs here, for the caller, every time:
      // nothing is stored on the server, so there is no file for someone the query would
      // refuse to read.
      GET: withApiHandler("/api/datasets/$id/data", async ({ request, params }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "query", "view");
          if (denied) return denied;

          const db = getDb();
          const dataset = await db
            .selectFrom("datasets as d")
            .innerJoin("saved_queries as q", "q.id", "d.saved_query_id")
            .select(["d.id", "d.name", "q.sql_content", "q.data_source_id", "q.is_deleted"])
            .where("d.id", "=", params.id)
            .executeTakeFirst();
          if (!dataset || dataset.is_deleted) return fail(404, "NOT_FOUND", "Dataset not found");

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", dataset.data_source_id)
            .where("is_active", "=", true)
            .executeTakeFirst();
          if (!dataSource) return fail(404, "NOT_FOUND", "Data source not found or inactive");

          // Read-only and per-table access, asked now, for this caller.
          const decision = await decideQueryRun(
            session.user,
            dataset.sql_content,
            dataset.data_source_id
          );
          if (!decision.ok) return fail(decision.status, decision.code, decision.message);

          const maxRows = datasetMaxRows();
          const { getConnection } = await import("@/lib/db/connection-manager");
          const connection = await getConnection(dataSource as unknown as DataSource);
          const started = Date.now();
          const result = await kyselySql
            .raw(capRowsSql(dataset.sql_content, dataSource.client_type, maxRows))
            .execute(connection);

          const { rows, truncated } = applyRowCap(result.rows as Record<string, unknown>[], maxRows);
          const arrowRows = coerceNumericColumns(toArrowRows(rows));
          const body = rowsToArrowIPC(arrowRows);
          const columns = describeColumns(arrowRows);

          const now = new Date().toISOString();
          await db
            .updateTable("datasets")
            .set({
              row_count: rows.length,
              byte_size: body.byteLength,
              columns: JSON.stringify(columns),
              last_built_at: now,
              updated_at: now,
            })
            .where("id", "=", dataset.id)
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "export",
            resourceType: "query",
            resourceId: dataset.id,
            details: {
              dataset: dataset.name,
              rowCount: rows.length,
              truncated,
              executionTime: Date.now() - started,
            },
          });

          // Copy into a plain ArrayBuffer: Arrow's Uint8Array is typed over ArrayBufferLike.
          return new Response(new Uint8Array(body), {
            headers: {
              "content-type": "application/vnd.apache.arrow.stream",
              "content-length": String(body.byteLength),
              "cache-control": "no-store",
              "x-dataset-rows": String(rows.length),
              "x-dataset-truncated": String(truncated),
            },
          });
        } catch (error) {
          recordFailure(error, "Error building dataset:");
          return fail(
            500,
            "EXECUTION_ERROR",
            error instanceof Error ? error.message : "Failed to build dataset"
          );
        }
      }),
    },
  },
});
