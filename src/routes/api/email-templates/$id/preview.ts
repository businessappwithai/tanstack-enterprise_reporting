import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { renderTemplate } from "@/lib/email/email-service";
import { authorizeTemplates, templateFailure } from "@/lib/email/template-api";
import {
  type EmailTemplateRow,
  placeholdersIn,
  toEmailTemplate,
  variablesForRow,
} from "@/lib/email/templates";
import { decideQueryRun } from "@/lib/permissions/runnable-query";
import { json } from "@/lib/server/response";
import type { DataSource } from "@/types/database";

const PREVIEW_ROWS = 5;

/**
 * Render a template against the first rows of its query, exactly as the batch worker would:
 * same renderer, same placeholder-to-column rule. The query runs through decideQueryRun, so
 * a preview cannot read a table its caller may not read, and only a single read-only
 * statement runs.
 */
export const Route = createFileRoute("/api/email-templates/$id/preview")({
  server: {
    handlers: {
      POST: withApiHandler("/api/email-templates/$id/preview", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeTemplates(request, "edit");
          if (who instanceof Response) return who;

          const db = getDb();
          const row = (await db
            .selectFrom("email_templates")
            .selectAll()
            .where("id", "=", params.id)
            .executeTakeFirst()) as unknown as EmailTemplateRow | undefined;
          if (!row) return templateFailure("NOT_FOUND", "Template not found", 404);
          const template = toEmailTemplate(row);

          const placeholders = [
            ...new Set([...placeholdersIn(template.subject), ...placeholdersIn(template.htmlBody)]),
          ];
          const unmapped = placeholders.filter(
            (p) => !p.startsWith("_") && !template.columnMappings[p]
          );

          const render = (data: Record<string, unknown>, index: number, total: number) => {
            const variables = variablesForRow(template.columnMappings, data, { index, total });
            return {
              rowIndex: index,
              data,
              preview: renderTemplate(template.htmlBody, variables, null, { html: true }),
              subjectPreview: renderTemplate(template.subject, variables, null, { html: false }),
            };
          };

          // A template with no query is static: one rendering, no row data.
          if (!template.queryId) {
            return json({
              success: true,
              data: { previewingFirst: 1, totalRows: 1, previews: [render({}, 0, 1)], unmapped },
            });
          }

          const query = await db
            .selectFrom("saved_queries")
            .select(["sql_content", "data_source_id"])
            .where("id", "=", template.queryId)
            .executeTakeFirst();
          if (!query) {
            return templateFailure("NOT_FOUND", "The template's query no longer exists", 404);
          }

          const decision = await decideQueryRun(who.user, query.sql_content, query.data_source_id);
          if (!decision.ok) return templateFailure(decision.code, decision.message, decision.status);

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", query.data_source_id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();
          if (!dataSource) return templateFailure("NOT_FOUND", "The query's data source no longer exists", 404);

          const connection = await getConnection(dataSource as unknown as DataSource);
          const statement = query.sql_content.trim().replace(/;\s*$/, "");

          let rows: Record<string, unknown>[];
          try {
            const limited = /\blimit\s+\d+/i.test(statement)
              ? statement
              : `${statement} LIMIT ${PREVIEW_ROWS}`;
            rows = ((await sql.raw(limited).execute(connection)).rows as Record<string, unknown>[])
              .slice(0, PREVIEW_ROWS);
          } catch (error) {
            return templateFailure(
              "QUERY_FAILED",
              `The template's query failed: ${error instanceof Error ? error.message : String(error)}`,
              422
            );
          }

          let totalRows = rows.length;
          try {
            const counted = await sql
              .raw<{ n: number | string }>(
                `SELECT COUNT(*) AS n FROM (${statement}) AS email_preview_count`
              )
              .execute(connection);
            totalRows = Number(counted.rows[0]?.n ?? rows.length);
          } catch {
            // Counting is a courtesy; the preview stands without it.
          }

          return json({
            success: true,
            data: {
              previewingFirst: rows.length,
              totalRows,
              previews: rows.map((r, i) => render(r, i, totalRows)),
              unmapped,
            },
          });
        } catch (error) {
          recordFailure(error, "[email-templates] preview failed:");
          return templateFailure("SERVER_ERROR", "Failed to preview the template", 500);
        }
      }),
    },
  },
});
