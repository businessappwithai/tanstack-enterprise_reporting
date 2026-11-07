import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { getDb } from "@/lib/db/config";
import { executeNlQueryPipeline } from "@/lib/mastra/nl-query-pipeline";
import { buildIntelligentUiWorkbook } from "@/lib/intelligent-ui/export-xlsx";
import { inferColumnKinds, validateSpec, type ViewSpec } from "@/lib/intelligent-ui/spec";
import type { DataSource } from "@/types/database";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_VIEWS = 20;

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

function failure(code: string, message: string, status: number, details?: unknown) {
  return json({ success: false, error: { code, message, details } }, { status });
}

/** ASCII-only, so it is safe inside a Content-Disposition header. */
function slug(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return s || "report";
}

/**
 * Excel export of what the Intelligent UI page shows.
 *
 * The browser sends the question, the SQL and the view specs — never rows. The query
 * is run again here through the same pipeline and entity-level checks as the NL Query
 * page, so a file cannot carry data its requester could not have read, and a caller
 * cannot pass off numbers of their own choosing as a report. The consequence is that
 * the file reflects the data now, which may differ from a page left open for a while.
 */
export const Route = createFileRoute("/api/intelligent-ui/export")({
  server: {
    handlers: {
      POST: withApiHandler("/api/intelligent-ui/export", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return failure("UNAUTHORIZED", "Unauthorized", 401);

          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            return failure("INVALID_JSON", "Request body must be valid JSON", 400);
          }

          const { query, data_source_id, generated_sql, views } = body ?? {};

          if (
            typeof query !== "string" ||
            !query.trim() ||
            typeof data_source_id !== "string" ||
            !data_source_id.trim()
          ) {
            return failure("INVALID_REQUEST", "query and data_source_id are required", 400);
          }
          if (typeof generated_sql !== "string" || !generated_sql.trim()) {
            return failure("SQL_REQUIRED", "generated_sql is required", 400);
          }
          if (views !== undefined && (!Array.isArray(views) || views.length > MAX_VIEWS)) {
            return failure("INVALID_REQUEST", `views must be an array of at most ${MAX_VIEWS}`, 400);
          }

          const db = getDb();
          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", data_source_id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();
          if (!dataSource) return failure("DATA_SOURCE_NOT_FOUND", "Data source not found", 404);

          const result = await executeNlQueryPipeline(
            query,
            generated_sql,
            session.user.id,
            dataSource as unknown as DataSource
          );

          if (!result.accessGranted) {
            return failure(
              "FORBIDDEN",
              result.error || "You do not have access to every entity in this query",
              403
            );
          }
          if (result.error || !result.queryResults) {
            return failure("QUERY_FAILED", result.error || "The query returned no result", 422);
          }

          const { columns, rows } = result.queryResults;
          const kinds = inferColumnKinds(columns, rows);

          const specs: ViewSpec[] = [];
          const problems: string[] = [];
          for (const [index, raw] of (views ?? []).entries()) {
            const checked = validateSpec(raw, columns, kinds);
            if (checked.ok) specs.push(checked.spec);
            else problems.push(...checked.errors.map((e) => `view ${index + 1}: ${e}`));
          }
          if (problems.length > 0) {
            return failure("INVALID_VIEW", "One or more views are not valid for this result", 422, {
              errors: problems,
            });
          }

          const generatedAt = new Date();
          const title = specs[0]?.title ?? query.trim().slice(0, 80);
          const buffer = await buildIntelligentUiWorkbook({
            title,
            question: query,
            sql: result.generatedSql,
            dataSourceName: (dataSource as { name?: string }).name ?? data_source_id,
            generatedBy: session.user.email,
            columns,
            rows,
            views: specs,
            generatedAt,
          });

          try {
            const { logAudit } = await import("@/lib/security/audit");
            await logAudit({
              userId: session.user.id,
              action: "export",
              resourceType: "query",
              resourceId: data_source_id,
              details: {
                format: "xlsx",
                source: "intelligent-ui",
                sql: result.generatedSql.substring(0, 500),
                rowCount: rows.length,
                viewCount: specs.length,
              },
            });
          } catch (auditError) {
            // The file has been built and the access checks have passed; a failed audit
            // write is logged loudly rather than withholding a report the user may read.
            recordFailure(auditError, "[intelligent-ui] Failed to audit-log export:");
          }

          const filename = `intelligent-ui-${slug(title)}-${generatedAt.toISOString().slice(0, 10)}.xlsx`;
          return new Response(new Uint8Array(buffer), {
            headers: {
              "Content-Type": XLSX_MIME,
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          recordFailure(error, "[intelligent-ui] Export failed:");
          return failure("SERVER_ERROR", "Failed to build the Excel export", 500);
        }
      }),
    },
  },
});
