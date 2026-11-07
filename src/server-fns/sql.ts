"use server";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ResultRow } from "@/types/database";
// Aliased: the query strings in this file are themselves named `sql`.
import { sql as rawSql } from "kysely";
import { requireAuth } from "@/lib/auth/middleware";
import { sqlEditorConfig, validatePageSize } from "@/lib/config/pagination";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { logAudit } from "@/lib/security/audit";
import { validateSQLWithAllowlist } from "@/lib/sql/antlr-validator";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import { executeSqlSchema, validateSqlSchema, introspectSchemaSchema } from "@/lib/schemas/sql";
import { withErrorHandler, NotFoundError } from "@/lib/server-fns/with-error-handler";
import { getLogger } from "@/lib/logging/logger";

const DEFAULT_TIMEOUT = 30000;

/** One widget's result, as batchExecuteSql returns it across the wire. */
interface WidgetQueryResult {
  columns: { name: string; type: string }[];
  rows: ResultRow[];
  rowCount: number;
  executionTime: number;
  truncated: boolean;
  pagination: { limit: number; offset: number; hasMore: boolean; serverSide: boolean };
}

interface BatchQueryInput {
  queries: Array<{
    widgetId: string;
    sql: string;
    dataSourceId: string;
    limit?: number;
    offset?: number;
  }>;
}

const batchQuerySchema = z.object({
  queries: z
    .array(
      z.object({
        widgetId: z.string(),
        sql: z.string(),
        dataSourceId: z.string(),
        limit: z.number().optional(),
        offset: z.number().optional(),
        timeout: z.number().optional(),
      })
    )
    .min(1)
    .max(50),
});

/**
 * Run a read-only statement under a time limit.
 *
 * Knex's `.timeout()` had no Kysely equivalent, so the caller's `timeout` was
 * being accepted and ignored. PostgreSQL's own `statement_timeout` does the
 * job, and `SET LOCAL` inside a transaction keeps it off the pooled
 * connection once the query is done.
 */
async function runWithTimeout(
  connection: Awaited<ReturnType<typeof getConnection>>,
  query: string,
  timeoutMs: number
) {
  return connection.transaction().execute(async (trx) => {
    await rawSql`SET LOCAL statement_timeout = ${rawSql.lit(timeoutMs)}`.execute(trx);
    return rawSql.raw<ResultRow>(query).execute(trx);
  });
}

export const batchExecuteSql = createServerFn({
  method: "POST",
})
  .inputValidator(batchQuerySchema)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();

    return withErrorHandler(
      async () => {
        if (!input.queries || input.queries.length === 0) {
          throw new Error("At least one query is required");
        }

        if (input.queries.length > 50) {
          throw new Error("Batch size cannot exceed 50 queries");
        }

        // Validate all queries first
        const validatedQueries = await Promise.all(
          input.queries.map(async (q) => {
            const validated = await executeSqlSchema.parseAsync({
              sql: q.sql,
              dataSourceId: q.dataSourceId,
              limit: q.limit,
              offset: q.offset,
            });
            return { widgetId: q.widgetId, ...validated };
          })
        );

        // Execute all queries in parallel
        const results = await Promise.allSettled(
          validatedQueries.map(async (query) => {
            const {
              widgetId,
              sql,
              dataSourceId,
              limit,
              offset = 0,
              timeout = DEFAULT_TIMEOUT,
            } = query;

            if (!isReadOnlyQuery(sql)) {
              throw new Error("Only SELECT queries are allowed");
            }

            const antlrValidation = validateSQLWithAllowlist(sql);
            if (!antlrValidation.valid) {
              const errorMessages = antlrValidation.errors.map((e) => e.message).join("; ");
              throw new Error(`SQL validation failed: ${errorMessages}`);
            }

            const db = getDb();
            const dataSource = await db
              .selectFrom("data_sources")
              .selectAll()
              .where("id", "=", dataSourceId)
              .where("is_active", "=", true)
              .executeTakeFirst();

            if (!dataSource) {
              throw new Error(`Data source not found: ${dataSourceId}`);
            }

            const connection = await getConnection(dataSource);
            const PAGE_SIZE = sqlEditorConfig.serverPageSize;

            // Execute with timeout
            const startTime = Date.now();
            const result = await runWithTimeout(connection, sql, timeout);

            const executionTime = Date.now() - startTime;

            let rows: ResultRow[] = [];
            let columns: { name: string; type: string }[] = [];

            rows = result.rows;

            if (rows.length > 0) {
              const first = rows[0] as ResultRow;
              columns = Object.keys(first).map((name) => ({
                name,
                type: typeof first[name],
              }));
            }

            return {
              widgetId,
              result: {
                columns,
                rows,
                rowCount: rows.length,
                executionTime,
                truncated: rows.length >= PAGE_SIZE,
                pagination: {
                  limit: PAGE_SIZE,
                  offset,
                  hasMore: false,
                  serverSide: true,
                },
              },
            };
          })
        );

        // Map results back to widget IDs
        const batchResults: Record<string, WidgetQueryResult> = {};
        const errors: Record<string, string> = {};

        for (const result of results) {
          if (result.status === "fulfilled") {
            batchResults[result.value.widgetId] = result.value.result;
          } else {
            const widgetId = validatedQueries[results.indexOf(result)]?.widgetId || "unknown";
            const errorMsg =
              result.reason instanceof Error ? result.reason.message : String(result.reason);
            errors[widgetId] = errorMsg;
          }
        }

        // Log the batch execution
        await logAudit({
          userId: session.user.id,
          action: "batch_execute",
          resourceType: "queries",
          details: {
            queryCount: input.queries.length,
            successCount: Object.keys(batchResults).length,
            errorCount: Object.keys(errors).length,
          },
        }).catch(() => {
          // Ignore audit log errors
        });

        return { results: batchResults, errors };
      },
      {
        user: session.user,
        action: "batch_execute",
        resourceType: "queries",
        details: { queryCount: input.queries.length },
      }
    );
  });

export const executeSql = createServerFn({
  method: "POST",
})
  .inputValidator(executeSqlSchema)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();

    return withErrorHandler(
      async () => {
        const { sql, dataSourceId, limit, offset = 0, timeout = DEFAULT_TIMEOUT } = input;

        if (!isReadOnlyQuery(sql)) {
          throw new Error("Only SELECT queries are allowed in the SQL editor");
        }

        // ANTLR validation: keyword allowlist enforcement (D11)
        const antlrValidation = validateSQLWithAllowlist(sql);
        if (!antlrValidation.valid) {
          const errorMessages = antlrValidation.errors.map((e) => e.message).join("; ");
          throw new Error(`SQL validation failed: ${errorMessages}`);
        }

        // Log validation warnings for security audit
        if (antlrValidation.warnings.length > 0) {
          const securityWarnings = antlrValidation.warnings.filter((w) => w.type === "security");
          if (securityWarnings.length > 0) {
            await logAudit({
              userId: session.user.id,
              action: "sql_validation_warning",
              resourceType: "query",
              resourceId: dataSourceId,
              details: {
                warnings: securityWarnings.map((w) => w.message),
                sql: sql.substring(0, 200),
              },
            });
          }
        }

        const db = getDb();
        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", dataSourceId)
          .where("is_active", "=", true)
          .executeTakeFirst();

        if (!dataSource) {
          throw new Error("Data source not found");
        }

        const connection = await getConnection(dataSource);
        const PAGE_SIZE = sqlEditorConfig.serverPageSize;
        const MAX_CLIENT_ROWS = sqlEditorConfig.maxClientRows;

        let totalRowCount = 0;
        const countSQL = `SELECT COUNT(*) as total FROM (${sql.replace(/;$/, "")}) as count_query`;

        try {
          const countResult = await runWithTimeout(connection, countSQL, timeout);

          if (Array.isArray(countResult) && countResult[0]) {
            totalRowCount = Number(countResult[0].total) || 0;
          }
        } catch (e) {
          getLogger("sql").note("error", "Could not count total rows:", { err: e });
        }

        const tooLargeForInteractive = totalRowCount > MAX_CLIENT_ROWS;
        if (tooLargeForInteractive) {
          return {
            columns: [],
            rows: [],
            rowCount: totalRowCount,
            executionTime: 0,
            truncated: false,
            pagination: { limit: PAGE_SIZE, offset, hasMore: false, serverSide: true },
            warning: {
              code: "DATASET_TOO_LARGE",
              message: `Query returns ${totalRowCount.toLocaleString()} rows, which exceeds the interactive limit of ${MAX_CLIENT_ROWS.toLocaleString()} rows.`,
              suggestion: "Run this query as a background job instead.",
              totalRows: totalRowCount,
              interactiveLimit: MAX_CLIENT_ROWS,
            },
          };
        }

        let limitedSQL = sql.trim();
        const effectiveLimit = validatePageSize(limit || sqlEditorConfig.serverPageSize);

        if (!/\bLIMIT\s+\d+/i.test(limitedSQL) && !/\bTOP\s+\d+/i.test(limitedSQL)) {
          if (limitedSQL.endsWith(";")) limitedSQL = limitedSQL.slice(0, -1);
          limitedSQL = `${limitedSQL} LIMIT ${effectiveLimit} OFFSET ${offset}`;
        } else if (
          /\bLIMIT\s+\d+/i.test(limitedSQL) &&
          !/\bOFFSET\s+\d+/i.test(limitedSQL) &&
          offset > 0
        ) {
          if (limitedSQL.endsWith(";")) limitedSQL = limitedSQL.slice(0, -1);
          limitedSQL = `${limitedSQL} OFFSET ${offset}`;
        }

        const limitMatch = limitedSQL.match(/\bLIMIT\s+(\d+)/i);
        if (limitMatch) {
          const userLimit = parseInt(limitMatch[1], 10);
          const validatedLimit = validatePageSize(userLimit);
          if (userLimit !== validatedLimit) {
            limitedSQL = limitedSQL.replace(/\bLIMIT\s+\d+/i, `LIMIT ${validatedLimit}`);
          }
        }

        const startTime = Date.now();
        const result = await runWithTimeout(connection, limitedSQL, timeout);

        const executionTime = Date.now() - startTime;

        let rows: ResultRow[] = [];
        let columns: { name: string; type: string }[] = [];

        rows = result.rows;

        if (rows.length > 0) {
          const first = rows[0] as ResultRow;
          columns = Object.keys(first).map((name) => ({
            name,
            type: typeof first[name],
          }));
        }

        await logAudit({
          userId: session.user.id,
          action: "execute",
          resourceType: "query",
          resourceId: dataSourceId,
          details: { sql: sql.substring(0, 500), rowCount: rows.length, executionTime },
        });

        return {
          columns,
          rows,
          rowCount: rows.length,
          totalRows: totalRowCount,
          executionTime,
          truncated: rows.length >= PAGE_SIZE,
          pagination: {
            limit: PAGE_SIZE,
            offset,
            totalRows: totalRowCount,
            hasMore: totalRowCount > 0 ? offset + rows.length < totalRowCount : false,
            serverSide: true,
            maxClientRows: MAX_CLIENT_ROWS,
          },
        };
      },
      {
        user: session.user,
        action: "execute",
        resourceType: "query",
        resourceId: input.dataSourceId,
      }
    );
  });

export const validateSql = createServerFn({
  method: "POST",
})
  .inputValidator(validateSqlSchema)
  .handler(async ({ data: input }) => {
    const _session = await requireAuth();
    const { sql, dataSourceId } = input;

    if (!sql) {
      throw new Error("SQL content is required");
    }

    const { validateSQL } = await import("@/lib/sql/validator");
    let dialect = "sqlite3";

    if (dataSourceId) {
      const db = getDb();
      const dataSource = await db
        .selectFrom("data_sources")
        .selectAll()
        .where("id", "=", dataSourceId)
        .executeTakeFirst();
      if (dataSource) {
        dialect = dataSource.client_type;
      }
    }

    const { ast: _ast, ...result } = validateSQL(sql, dialect);
    return result;
  });

export const introspectSchema = createServerFn({
  method: "GET",
})
  .inputValidator(introspectSchemaSchema)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const { dataSourceId } = input;

    const db = getDb();
    const dataSource = await db
      .selectFrom("data_sources")
      .selectAll()
      .where("id", "=", dataSourceId)
      .where("is_active", "=", true)
      .executeTakeFirst();

    if (!dataSource) {
      throw new Error("Data source not found or not active");
    }

    const connection = await getConnection(dataSource);
    const { introspectSchema: introspect } = await import("@/lib/sql/schema-introspection");
    const { schema, logs } = await introspect(connection, dataSource.client_type);

    let syncResult:
      | {
          entitiesCreated: number;
          entitiesUpdated: number;
          fieldsCreated: number;
          fieldsUpdated: number;
          errors: string[];
        }
      | undefined;
    try {
      const { SyncService } = await import("@/lib/metadata/sync-service");
      syncResult = await SyncService.syncDataSource(dataSourceId, session.user.id);
    } catch (_e) {
      getLogger("sql").note("error", "[Schema Sync] Failed to sync metadata:", { detail: [_e] });
    }

    if (schema.tables.length === 0 && schema.views.length === 0) {
      return {
        ...schema,
        logs,
        warning:
          "No tables or views found in this database. The database may be empty or you may not have permission to access the tables.",
      };
    }

    return {
      ...schema,
      logs,
      metadataSync: syncResult
        ? {
            entitiesCreated: syncResult.entitiesCreated,
            entitiesUpdated: syncResult.entitiesUpdated,
            fieldsCreated: syncResult.fieldsCreated,
            fieldsUpdated: syncResult.fieldsUpdated,
          }
        : undefined,
    };
  });
