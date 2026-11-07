import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { resolveRBACContext } from "@/lib/monitoring/rbac-workflow-context";
import type { SecurityContext } from "@/lib/auth/rbac";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

function isoNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function deserializeDefinition(row: Record<string, unknown>) {
  return {
    ...row,
    metric_columns: JSON.parse((row.metric_columns as string) || "[]"),
    dimension_columns: JSON.parse((row.dimension_columns as string) || "[]"),
    filter_config: row.filter_config ? JSON.parse(row.filter_config as string) : null,
    output_formats: JSON.parse((row.output_formats as string) || '["csv"]'),
    recipient_config: JSON.parse((row.recipient_config as string) || "[]"),
    schedule_enabled: !!row.schedule_enabled,
  };
}

export const Route = createFileRoute("/api/report-generation/definitions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/report-generation/definitions", async ({ request }: { request: Request }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        const db = getDb();
        const url = new URL(request.url);
        const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
        const pageSize = Math.min(
          100,
          Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10))
        );
        const history = url.searchParams.get("history") === "true";
        const since = url.searchParams.get("since"); // e.g. "7d", "30d"
        const titleLike = url.searchParams.get("titleLike");

        let query = (db as any)
          .selectFrom("nl_report_definitions as rd")
          .leftJoin("data_sources as ds", "ds.id", "rd.data_source_id");

        // Non-admin users only see their own
        const isAdmin = (session.user as any).roles?.some((r: any) => {
          const n = (r.name || "").toLowerCase();
          return n === "admin" || n === "administrator" || n.startsWith("admin");
        });
        if (!isAdmin) {
          query = query.where("rd.created_by", "=", session.user.id);
        }

        // Date filter
        if (since) {
          const days = parseInt(since.replace("d", ""), 10);
          if (!isNaN(days) && days > 0) {
            query = query.where(
              "rd.created_at",
              ">=",
              new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace("T", " ")
            );
          }
        }

        // Title search
        if (titleLike) {
          query = query.where("rd.title", "like", `%${titleLike}%`);
        }

        // Count
        const countResult = await query
          .select((eb: any) => [eb.fn.count("rd.id").as("total")])
          .executeTakeFirst();
        const total = Number(countResult?.total ?? 0);

        // Fetch definitions with data source name
        const rows = await (db as any)
          .selectFrom("nl_report_definitions as rd")
          .leftJoin("data_sources as ds", "ds.id", "rd.data_source_id")
          .select([
            "rd.id",
            "rd.title",
            "rd.created_by",
            "rd.data_source_id",
            "rd.nl_query",
            "rd.generated_sql",
            "rd.metric_columns",
            "rd.dimension_columns",
            "rd.filter_config",
            "rd.date_range_from",
            "rd.date_range_to",
            "rd.chart_type",
            "rd.output_formats",
            "rd.recipient_config",
            "rd.schedule_cron",
            "rd.schedule_enabled",
            "rd.last_run_at",
            "rd.last_run_status",
            "rd.created_at",
            "rd.updated_at",
            "ds.name as data_source_name",
          ])
          .where(isAdmin ? (eb: any) => eb : (eb: any) => eb("rd.created_by", "=", session.user.id))
          .orderBy("rd.created_at", "desc")
          .limit(pageSize)
          .offset(page * pageSize)
          .execute();

        const definitions = rows.map(deserializeDefinition);

        // If history mode, also attach artifact counts
        if (history) {
          for (const def of definitions) {
            const artifactCount = await (db as any)
              .selectFrom("generated_report_artifacts")
              .where("report_definition_id", "=", (def as any).id)
              .select((eb: any) => [eb.fn.count("id").as("cnt")])
              .executeTakeFirst();
            (def as any).artifactCount = Number(artifactCount?.cnt ?? 0);
          }
        }

        return json({ definitions, total, page, pageSize });
      }),

      POST: withApiHandler("/api/report-generation/definitions", async ({ request }: { request: Request }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        const body = await request.json();

        // ── Dry-run: NL → SQL via Mastra agent + 10-row preview ──────────────────
        if (body.dryRun) {
          const dryRequired = ["dataSourceId", "nlQuery"] as const;
          for (const field of dryRequired) {
            if (!body[field])
              return json({ error: `Missing required field: ${field}` }, { status: 400 });
          }
          let _capturedSQL = "";
          try {
            const { runReportBuilderAgent } = await import(
              "../../../../mastra/agents/supervisor-agent"
            );
            const { getDb } = await import("@/lib/db/config");

            // Fetch schema text for the data source — include entity descriptions and FK info
            const appDb = getDb();
            const dsEntities = await (appDb as any)
              .selectFrom("metadata_entity_header as e")
              .leftJoin("metadata_entity_field as f", "f.entity_header_id", "e.id")
              .where("e.data_source_id", "=", body.dataSourceId)
              .where("e.is_active", "=", 1)
              .select([
                "e.entity_name",
                "e.description as entity_description",
                "f.field_name",
                "f.data_type",
                "f.description as field_description",
                "f.is_foreign_key",
                "f.foreign_key_table",
                "f.foreign_key_column",
              ])
              .execute();

            // Group by entity, building rich column descriptions
            const tableMap: Record<string, string[]> = {};
            const entityDescMap: Record<string, string> = {};
            const fkMap: Record<string, { col: string; refTable: string; refCol: string }[]> = {};

            for (const row of dsEntities as any[]) {
              if (!row.entity_name) continue;
              if (!tableMap[row.entity_name]) {
                tableMap[row.entity_name] = [];
                if (row.entity_description) entityDescMap[row.entity_name] = row.entity_description;
              }
              if (row.field_name) {
                let colEntry = `${row.field_name} (${row.data_type ?? "text"})`;
                if (row.field_description) colEntry += ` -- ${row.field_description}`;
                tableMap[row.entity_name].push(colEntry);
                if (row.is_foreign_key && row.foreign_key_table) {
                  if (!fkMap[row.entity_name]) fkMap[row.entity_name] = [];
                  fkMap[row.entity_name].push({
                    col: row.field_name,
                    refTable: row.foreign_key_table,
                    refCol: row.foreign_key_column ?? "id",
                  });
                }
              }
            }

            const schemaText = Object.entries(tableMap)
              .map(([t, cols]) => {
                const desc = entityDescMap[t] ? `\nDescription: ${entityDescMap[t]}` : "";
                return `Table: ${t}${desc}\nColumns: ${cols.join(", ")}`;
              })
              .join("\n\n");

            // Fetch the data source connection to build relationship hints from actual DB
            const dsRow = await (appDb as any)
              .selectFrom("data_sources")
              .where("id", "=", body.dataSourceId)
              .selectAll()
              .executeTakeFirst();
            if (!dsRow) return json({ error: "Data source not found" }, { status: 404 });
            const conn = await getConnection(dsRow);

            // Build join hints from metadata FK relationships
            const directJoins: string[] = [];
            const multiHopJoins: string[] = [];

            for (const [tableA, edges] of Object.entries(fkMap)) {
              for (const { col: colAB, refTable: tableB, refCol } of edges) {
                directJoins.push(
                  `${tableA} JOIN ${tableB} ON ${tableA}.${colAB}::uuid = ${tableB}.${refCol}`
                );
                // 2-hop: tableA → tableB → tableC
                for (const { col: colBC, refTable: tableC, refCol: refColC } of fkMap[tableB] ??
                  []) {
                  if (tableC !== tableA) {
                    multiHopJoins.push(
                      `${tableA} → ${tableC} (via ${tableB}): JOIN ${tableB} ON ${tableA}.${colAB}::uuid = ${tableB}.${refCol} JOIN ${tableC} ON ${tableB}.${colBC}::uuid = ${tableC}.${refColC}`
                    );
                  }
                }
              }
            }

            // Put join paths FIRST so the LLM sees them before the long table list
            const joinSection = [
              multiHopJoins.length
                ? `MULTI-HOP JOIN PATHS — YOU MUST USE THESE EXACT PATHS FOR CROSS-TABLE QUERIES:\n${multiHopJoins.slice(0, 20).join("\n")}`
                : "",
              directJoins.length
                ? `DIRECT FK JOINS (all varchar→uuid, ::uuid cast required):\n${directJoins.slice(0, 25).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n");

            const schemaWithRelations = (joinSection ? `${joinSection}\n\n` : "") + schemaText;

            // Use the report builder agent directly — pass the full NL query as the metric
            const reportResult = await runReportBuilderAgent(
              body.nlQuery,
              `PostgreSQL database. Use ONLY tables and columns listed in the DATABASE SCHEMA. Cast varchar *_id columns to ::uuid when joining to uuid id columns.`,
              schemaWithRelations,
              "all time — do NOT add any date/time filter unless the user's query explicitly mentions a time period (e.g. 'last 7 days', 'this month', 'Q1 2026'). If no time period is mentioned, omit WHERE clauses on date columns entirely."
            );

            let generatedSQL = reportResult.sql;
            _capturedSQL = generatedSQL;

            // Try preview; if SQL fails, retry once with error feedback
            const runPreview = async (querySql: string) => {
              const clean = querySql.replace(/;\s*$/, "");
              const preview = `SELECT * FROM (${clean}) AS _preview LIMIT 10`;
              const result = await sql.raw(preview).execute(conn);
              return Array.isArray(result.rows) ? result.rows : (result as any);
            };

            let previewRows: any[];
            try {
              previewRows = await runPreview(generatedSQL);
            } catch (sqlErr: any) {
              const sqlErrMsg = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
              // Extract missing column hint — always provide relevant multi-hop paths
              const colMatch = sqlErrMsg.match(/column [\w.]*?\.?(\w+) does not exist/);
              const missingCol = colMatch?.[1] ?? "";
              const relevantPaths = missingCol
                ? multiHopJoins.filter((p) => p.includes(missingCol.replace(/_id$/, "")))
                : multiHopJoins.slice(0, 5);
              const fixHint =
                `\nCRITICAL FIX REQUIRED: The previous SQL had a wrong column/join. ` +
                (relevantPaths.length
                  ? `Use these exact join paths:\n${relevantPaths.join("\n")}`
                  : `Check MULTI-HOP JOIN PATHS in the schema.`) +
                `\nDo NOT guess column names. Only use columns that appear in the DATABASE SCHEMA above.`;

              // Retry: feed SQL error back to agent with specific fix hint
              const retryResult = await runReportBuilderAgent(
                body.nlQuery,
                `PostgreSQL database. Use ONLY tables and columns in the DATABASE SCHEMA. Cast varchar *_id columns to ::uuid when joining.\nPREVIOUS SQL FAILED: ${generatedSQL}\nERROR: ${sqlErrMsg}${fixHint}`,
                schemaWithRelations,
                "current period"
              );
              generatedSQL = retryResult.sql;
              _capturedSQL = generatedSQL;
              previewRows = await runPreview(generatedSQL);
            }
            const previewColumns = previewRows.length > 0 ? Object.keys(previewRows[0]) : [];

            return json({
              generatedSQL,
              previewRows,
              previewColumns,
              intent: {
                intentType: "report_generation",
                reportTitle: body.nlQuery,
                dataSourceHint: body.dataSourceId,
                metrics: reportResult.metric_column ? [reportResult.metric_column] : [],
                dimensions: [],
                filters: [],
                outputFormats: ["csv"],
                recipients: [],
                schedule: null,
                chartType: "bar",
              },
            });
          } catch (err: any) {
            const msg = err instanceof Error ? err.message : String(err);
            return json({ error: `Dry-run failed: ${msg}` }, { status: 500 });
          }
        }

        // Validate required fields for full creation
        const required = [
          "title",
          "dataSourceId",
          "nlQuery",
          "generatedSQL",
          "outputFormats",
        ] as const;
        for (const field of required) {
          if (!body[field]) {
            return json({ error: `Missing required field: ${field}` }, { status: 400 });
          }
        }

        const db = getDb();
        const id = crypto.randomUUID();
        const now = isoNow();

        // Resolve and snapshot RBAC context at creation time
        const userRoles = await (db as any)
          .selectFrom("user_roles")
          .innerJoin("roles", "roles.id", "user_roles.role_id")
          .where("user_roles.user_id", "=", session.user.id)
          .select(["roles.id as id", "roles.name as name"])
          .execute();

        const securityContext: SecurityContext = {
          userId: session.user.id,
          roles: userRoles.map((r: any) => r.name as string),
          permissions: [],
        };

        const rbacSnapshot = await resolveRBACContext(session.user.id, securityContext);

        await (db as any)
          .insertInto("nl_report_definitions")
          .values({
            id,
            title: body.title,
            created_by: session.user.id,
            data_source_id: body.dataSourceId,
            nl_query: body.nlQuery,
            generated_sql: body.generatedSQL,
            metric_columns: JSON.stringify(body.metricColumns ?? []),
            dimension_columns: JSON.stringify(body.dimensionColumns ?? []),
            filter_config: body.filterConfig ? JSON.stringify(body.filterConfig) : null,
            date_range_from: body.dateRangeFrom ?? null,
            date_range_to: body.dateRangeTo ?? null,
            chart_type: body.chartType ?? "bar",
            output_formats: JSON.stringify(body.outputFormats),
            recipient_config: JSON.stringify(body.recipients ?? []),
            schedule_cron: body.scheduleCron ?? null,
            schedule_timezone: body.scheduleTimezone ?? "UTC",
            schedule_enabled: body.scheduleCron ? 1 : 0,
            rbac_snapshot: JSON.stringify(rbacSnapshot),
            rbac_snapshot_version: 1,
            last_run_status: null,
            last_run_at: null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        // If immediate run requested, trigger the worker
        if (!body.scheduleCron || body.runNow) {
          const { executeReportGeneration } = await import(
            "@/lib/report-generation/report-generation-worker"
          );
          const result = await executeReportGeneration({
            reportDefinitionId: id,
            triggeredBy: "manual",
          });

          return json({ definition: { id }, result }, { status: 201 });
        }

        return json({ definition: { id } }, { status: 201 });
      }),
    },
  },
});
