/**
 * Natural Language Query Pipeline
 *
 * Orchestrates the full NL-to-SQL workflow:
 * 1. Fetch schema context (RAG) for the data source
 * 2. Generate SQL from natural language using LLM
 * 3. Parse and validate the generated SQL using ANTLR-based parser
 * 4. Check entity-level RBAC permissions
 * 5. Execute the query if access is granted
 * 6. Return results with metadata
 */

import { sql } from "kysely";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { logAudit } from "@/lib/security/audit";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import type { DataSource, NlQueryPipelineResult } from "@/types/database";
import { validateSqlAccess, validateSqlTokens } from "./sql-parser";
import { getLogger } from "@/lib/logging/logger";

const MAX_RESULT_ROWS = 1000;

interface PipelineOptions {
  maxRows?: number;
  generateChart?: boolean;
  chartType?: string;
}

/**
 * Generate SQL from a natural language query using the schema context.
 * This constructs a detailed prompt with schema info for the LLM.
 */
export function buildSqlGenerationPrompt(
  naturalLanguageQuery: string,
  schemaText: string,
  dialect: string
): string {
  const dialectName = getDialectName(dialect);

  return `You are an expert SQL query generator for ${dialectName} databases.

IMPORTANT RULES:
1. Generate ONLY valid ${dialectName} SQL. No explanation, no markdown, no code fences.
2. Use only the tables and columns described in the schema below.
3. Use proper JOIN syntax when combining tables.
4. Include appropriate WHERE clauses based on the query intent.
5. Use aliases for readability when joining multiple tables.
6. Limit results to ${MAX_RESULT_ROWS} rows unless the user asks for all.
7. For aggregation queries, always include GROUP BY.
8. For date/time filtering, use the appropriate ${dialectName} date functions.
9. Output ONLY the SQL statement, nothing else. No comments, no explanation.
10. If the natural language query is ambiguous, make reasonable assumptions based on the schema.

DATABASE SCHEMA:
${schemaText}

USER QUERY: ${naturalLanguageQuery}

SQL:`;
}

/**
 * Build a prompt for generating chart configuration from query results
 */
export function buildChartPrompt(
  naturalLanguageQuery: string,
  columns: string[],
  sampleRows: Record<string, unknown>[],
  requestedChartType?: string
): string {
  return `Based on the following query results, generate a chart configuration as a JSON object.

USER REQUEST: ${naturalLanguageQuery}
${requestedChartType ? `REQUESTED CHART TYPE: ${requestedChartType}` : "Choose the most appropriate chart type."}

AVAILABLE COLUMNS: ${columns.join(", ")}

SAMPLE DATA (first 5 rows):
${JSON.stringify(sampleRows.slice(0, 5), null, 2)}

Generate a JSON object with this exact structure (no markdown, no explanation, ONLY valid JSON):
{
  "chartType": "bar" | "line" | "area" | "pie" | "scatter",
  "title": "descriptive chart title",
  "xAxis": { "field": "column_name", "label": "Display Label" },
  "yAxis": [{ "field": "column_name", "label": "Display Label" }],
  "colors": ["#3b82f6", "#10b981", "#8b5cf6"]
}

JSON:`;
}

/**
 * Execute the full NL query pipeline
 */
export async function executeNlQueryPipeline(
  naturalLanguageQuery: string,
  generatedSql: string,
  userId: string,
  dataSource: DataSource,
  options: PipelineOptions = {}
): Promise<NlQueryPipelineResult> {
  const startTime = Date.now();
  const maxRows = options.maxRows || MAX_RESULT_ROWS;

  // Step 1: Validate SQL tokens
  const tokenValidation = validateSqlTokens(generatedSql);
  if (!tokenValidation.valid) {
    return {
      naturalLanguageQuery,
      generatedSql,
      parsedEntities: [],
      accessCheckResults: [],
      accessGranted: false,
      error: `Generated SQL has syntax errors: ${tokenValidation.errors.join("; ")}`,
    };
  }

  // Step 1b: Only a single read-only statement may run. Entity access answers "may this
  // user read these tables"; it says nothing about writing them, so without this an
  // INSERT, or `UPDATE …; SELECT 1`, into a table the user can read ran as written —
  // the SQL editor already refuses both. See src/lib/permissions/runnable-query.ts.
  if (!isReadOnlyQuery(generatedSql)) {
    const message = "This query is not a single read-only statement and was not run.";
    try {
      await logAudit({
        userId,
        action: "execute",
        resourceType: "query",
        resourceId: dataSource.id,
        details: { blocked: "not_read_only", source: "nl-query", sql: generatedSql.slice(0, 500) },
      });
    } catch (auditError) {
      getLogger("nlquery").note("error", "[nl-query] Failed to audit-log a refused statement:", { err: auditError });
    }
    return {
      naturalLanguageQuery,
      generatedSql,
      parsedEntities: [],
      accessCheckResults: [],
      accessGranted: false,
      error: message,
    };
  }

  // Step 2: Parse SQL and check RBAC
  const { entities, accessResults, allGranted, deniedEntities } = await validateSqlAccess(
    generatedSql,
    userId,
    dataSource.id,
    dataSource.client_type
  );

  // Log the query attempt
  const db = getDb();
  const historyId = crypto.randomUUID();
  await (db as any).insertInto("nl_query_history").values({
    id: historyId,
    data_source_id: dataSource.id,
    user_id: userId,
    natural_language_query: naturalLanguageQuery,
    generated_sql: generatedSql,
    parsed_entities: JSON.stringify(entities),
    access_check_result: allGranted ? "granted" : "denied",
    access_check_details: JSON.stringify(accessResults),
    created_at: new Date().toISOString(),
  });

  if (!allGranted) {
    const deniedList = deniedEntities.join(", ");

    // Update history with denial
    await (db as any)
      .updateTable("nl_query_history")
      .where("id", "=", historyId)
      .set({
        error_message: `Access denied to entities: ${deniedList}`,
      });

    return {
      naturalLanguageQuery,
      generatedSql,
      parsedEntities: entities,
      accessCheckResults: accessResults,
      accessGranted: false,
      error: `Access denied. You do not have permission to query the following entities: ${deniedList}. Contact your administrator to request access.`,
    };
  }

  // Step 3: Execute the query
  try {
    const connection = await getConnection(dataSource);

    // Add LIMIT if not present
    let executableSql = generatedSql.trim();
    // A word-boundary test, not a substring one: `.includes("limit")` also matched a
    // column called `rate_limit`, a literal 'limit', or `unlimited`, and the row cap was
    // silently skipped for any query that contained them.
    if (!/\blimit\s+\d+/i.test(executableSql)) {
      executableSql = executableSql.replace(/;?\s*$/, ` LIMIT ${maxRows};`);
    }

    const queryStart = Date.now();
    const result = await sql.raw(executableSql).execute(connection);
    const executionTimeMs = Date.now() - queryStart;

    const resultRows: Record<string, unknown>[] = result.rows as Record<string, unknown>[];

    // The SQL editor audit-logs every run; this path logged only the refusals. Who read what,
    // through the assistant, is exactly what an audit trail is for.
    try {
      await logAudit({
        userId,
        action: "execute",
        resourceType: "query",
        resourceId: dataSource.id,
        details: {
          source: "nl-query",
          sql: generatedSql.slice(0, 500),
          rowCount: resultRows.length,
          executionTime: executionTimeMs,
        },
      });
    } catch (auditError) {
      getLogger("nlquery").note("error", "[nl-query] Failed to audit-log an execution:", { err: auditError });
    }

    const columns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [];

    // Update history with success
    await (db as any)
      .updateTable("nl_query_history")
      .where("id", "=", historyId)
      .set({
        execution_result: JSON.stringify({ rowCount: resultRows.length, columns }),
        execution_time_ms: executionTimeMs,
      });

    return {
      naturalLanguageQuery,
      generatedSql,
      parsedEntities: entities,
      accessCheckResults: accessResults,
      accessGranted: true,
      queryResults: {
        columns,
        rows: resultRows,
        totalRows: resultRows.length,
        executionTimeMs,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Update history with error
    await (db as any)
      .updateTable("nl_query_history")
      .where("id", "=", historyId)
      .set({
        access_check_result: "error",
        error_message: errorMessage,
        execution_time_ms: Date.now() - startTime,
      });

    return {
      naturalLanguageQuery,
      generatedSql,
      parsedEntities: entities,
      accessCheckResults: accessResults,
      accessGranted: true,
      error: `Query execution failed: ${errorMessage}`,
    };
  }
}

function getDialectName(dialect: string): string {
  switch (dialect) {
    case "pg":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mssql":
      return "Microsoft SQL Server";
    case "sqlite3":
    case "sqlite":
      return "SQLite";
    case "oracledb":
      return "Oracle";
    default:
      return "SQL";
  }
}
