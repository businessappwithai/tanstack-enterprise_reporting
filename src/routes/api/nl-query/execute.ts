import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { executeNlQueryPipeline } from "@/lib/mastra/nl-query-pipeline";
import { storeQueryEmbedding } from "@/lib/mastra/rag-store";
import type { DataSource } from "@/types/database";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

function failure(code: string, message: string, status: number) {
  return json({ success: false, error: { code, message } }, { status });
}

export const Route = createFileRoute("/api/nl-query/execute")({
  server: {
    handlers: {
      POST: withApiHandler("/api/nl-query/execute", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return failure("UNAUTHORIZED", "Unauthorized", 401);
          }

          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            return failure("INVALID_JSON", "Request body must be valid JSON", 400);
          }

          const { query, data_source_id, generated_sql } = body ?? {};

          if (
            typeof query !== "string" ||
            !query.trim() ||
            typeof data_source_id !== "string" ||
            !data_source_id.trim()
          ) {
            return failure("INVALID_REQUEST", "query and data_source_id are required", 400);
          }

          // This route validates and runs SQL; it does not write it. A request without
          // any is a caller bug, and it is reported as one rather than answered with a
          // stand-in query whose result would look like a real answer.
          if (typeof generated_sql !== "string" || !generated_sql.trim()) {
            return failure(
              "SQL_REQUIRED",
              "generated_sql is required: this endpoint runs the SQL it is given and does not generate any",
              400
            );
          }

          const db = getDb();

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", data_source_id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!dataSource) {
            return failure("DATA_SOURCE_NOT_FOUND", "Data source not found", 404);
          }

          const result = await executeNlQueryPipeline(
            query,
            generated_sql,
            session.user.id,
            dataSource as unknown as DataSource
          );

          // Store successful query in RAG for future similarity search
          if (result.accessGranted && result.queryResults && !result.error) {
            const ds = dataSource as unknown as DataSource;
            getConnection(ds)
              .then((conn) =>
                storeQueryEmbedding(
                  conn,
                  ds.id,
                  query,
                  result.generatedSql,
                  null,
                  result.queryResults!.totalRows,
                  result.queryResults!.executionTimeMs
                )
              )
              .catch((e) => getLogger("nlquery").event("nlquery.embedding.store_failed", { target: "query", err: e }));
          }

          return json({
            success: true,
            data: result,
          });
        } catch (error) {
          throw serverFailure(error, "Failed to execute query");
        }
      }),
    },
  },
});
