import { createFileRoute } from "@tanstack/react-router";
import { sql as kyselySql } from "kysely";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { sqlEditorConfig, validatePageSize } from "@/lib/config/pagination";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { appError } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { getLogger } from "@/lib/logging/logger";
import { setRequestContext } from "@/lib/logging/request-context";
import { validateQueryAccess } from "@/lib/permissions/query-access-validator";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";
import { toQueryError } from "@/lib/sql/query-error";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import type { DataSource, User } from "@/types/database";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/sql/execute")({
  server: {
    handlers: {
      POST: withApiHandler("/api/sql/execute", async ({ request }) => {
        const log = getLogger("sql");

        // The wrapper owns the try/catch: anything thrown here becomes the platform's error
        // envelope, logged once by category. The request body is read exactly once, below;
        // the old catch read it a second time, which throws on a consumed body, so every SQL
        // error hung the SQL Editor.
        const session = await getSession(request);
        if (!session?.user) {
          throw appError("UNAUTHORIZED", { message: "Not authenticated" });
        }
        setRequestContext({ userId: session.user.id });
        const userId = session.user.id;

        const body = (await request.json()) as {
          sql: string;
          dataSourceId: string;
          parameters?: unknown[];
          limit?: number;
          offset?: number;
          timeout?: number;
        };

        const { sql, dataSourceId, limit, offset } = body;

        if (!sql) throw appError("INVALID_INPUT", { message: "SQL content is required" });
        if (!dataSourceId) throw appError("INVALID_INPUT", { message: "Data source ID is required" });

        if (!isReadOnlyQuery(sql)) {
          log.event("sql.query.refused", { dataSourceId, reason: "not a single read-only statement", userId });
          throw appError("FORBIDDEN", { message: "Only SELECT queries are allowed in the SQL editor" });
        }

        const db = getDb();
        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", dataSourceId)
          .where("is_active", "=", true)
          .executeTakeFirst();

        if (!dataSource) throw appError("NOT_FOUND", { message: "Data source not found" });

        /*
         * Which tables this caller may read.
         *
         * Everything above this point checks the *shape* of the request — a
         * session exists, the SQL is a SELECT, the data source is real. None
         * of it asks whether this user may read the tables the SELECT names,
         * and the route went straight from that to executing the query. Any
         * signed-in user could read every table of any data source they could
         * name, whatever their `ds_entity_permissions` said.
         *
         * `validateQueryAccess` is the check the NL-query path already makes
         * before it executes (nl-query.ts, step 4). Using the same function
         * here rather than a second one is the point: two implementations of
         * "may this user read this table" is precisely how the reader and the
         * writer of `ds_entity_permissions` came to disagree in the first
         * place. It bypasses for system admins and treats a user with no
         * roles on the data source as having no access.
         */
        const accessValidation = await validateQueryAccess(
          session.user as unknown as User,
          sql,
          dataSourceId
        );

        if (!accessValidation.allowed) {
          log.event("sql.query.refused", {
            dataSourceId,
            reason: "tables the caller may not read",
            userId,
          });
          // Names the tables rather than refusing blankly: the caller wrote the query and
          // can only fix it if they know which part of it they may not read.
          throw appError("QUERY_ACCESS_DENIED", {
            message:
              accessValidation.reason || "You do not have access to every table in this query",
          });
        }

        const connection = await getConnection(dataSource as unknown as DataSource);

        const PAGE_SIZE = sqlEditorConfig.serverPageSize;
        const MAX_CLIENT_ROWS = sqlEditorConfig.maxClientRows;

        let totalRowCount = 0;

        // Try to get count, but don't fail if it doesn't work
        // Different databases have different syntax quirks
        try {
          const cleanSql = sql.trim().replace(/;$/, "");
          const countSQL = `SELECT COUNT(*) as total FROM (${cleanSql}) as count_query`;
          const { rows: countRows } = await kyselySql.raw(countSQL).execute(connection);
          totalRowCount = Number((countRows[0] as Record<string, unknown>)?.total) || 0;
        } catch {
          // If counting fails, just continue without total row count
          totalRowCount = 0;
        }

        let limitedSQL = sql.trim();
        const effectiveLimit = validatePageSize(limit || sqlEditorConfig.serverPageSize);
        const effectiveOffset = offset || 0;

        if (!/\bLIMIT\s+\d+/i.test(limitedSQL) && !/\bTOP\s+\d+/i.test(limitedSQL)) {
          if (limitedSQL.endsWith(";")) limitedSQL = limitedSQL.slice(0, -1);
          limitedSQL = `${limitedSQL} LIMIT ${effectiveLimit} OFFSET ${effectiveOffset}`;
        } else if (
          /\bLIMIT\s+\d+/i.test(limitedSQL) &&
          !/\bOFFSET\s+\d+/i.test(limitedSQL) &&
          effectiveOffset > 0
        ) {
          if (limitedSQL.endsWith(";")) limitedSQL = limitedSQL.slice(0, -1);
          limitedSQL = `${limitedSQL} OFFSET ${effectiveOffset}`;
        }

        const limitMatch = limitedSQL.match(/\bLIMIT\s+(\d+)/i);
        if (limitMatch) {
          const userLimit = parseInt(limitMatch[1], 10);
          const validatedLimit = validatePageSize(userLimit);
          if (userLimit !== validatedLimit) {
            limitedSQL = limitedSQL.replace(/\bLIMIT\s+\d+/i, `LIMIT ${validatedLimit}`);
          }
        }

        const executionStartTime = Date.now();

        let rawRows: unknown[];
        try {
          ({ rows: rawRows } = await kyselySql.raw(limitedSQL).execute(connection));
        } catch (error) {
          const failure = toQueryError(error);
          log.event("sql.query.failed", {
            dataSourceId,
            errorCode: failure.code,
            durationMs: Date.now() - executionStartTime,
            sqlChars: sql.length,
            userId,
          });
          await logAudit({
            userId,
            action: "execute",
            resourceType: "query",
            resourceId: dataSourceId,
            details: { sql: sql.substring(0, 500), failed: failure.code },
          }).catch(() => undefined);
          throw failure;
        }

        const executionTime = Date.now() - executionStartTime;

        const rows = rawRows as Record<string, unknown>[];

        // Database drivers may return values as strings from the wire protocol;
        // infer numeric/boolean columns by checking if every non-null value
        // in the first row (and a few sample rows) looks like a number/boolean.
        function inferType(colName: string): string {
          const samples = rows.slice(0, 5);
          const nonNull = samples
            .map((r) => r[colName])
            .filter((v) => v !== null && v !== undefined && v !== "");
          if (nonNull.length === 0) return "string";
          const allNumeric = nonNull.every(
            (v) =>
              typeof v === "number" ||
              (typeof v === "string" && !Number.isNaN(Number(v)) && v.trim() !== "")
          );
          if (allNumeric) return "number";
          if (nonNull.every((v) => typeof v === "boolean")) return "boolean";
          return "string";
        }

        const columns: { name: string; type: string }[] =
          rows.length > 0
            ? Object.keys(rows[0]).map((name) => ({ name, type: inferType(name) }))
            : [];

        log.event("sql.query.executed", {
          dataSourceId,
          rowCount: rows.length,
          durationMs: executionTime,
          userId,
        });

        await logAudit({
          userId: session.user.id,
          action: "execute",
          resourceType: "query",
          resourceId: dataSourceId,
          details: { sql: sql.substring(0, 500), rowCount: rows.length, executionTime },
        });

        return json({
          success: true,
          data: {
            columns,
            rows,
            rowCount: rows.length,
            totalRows: totalRowCount,
            executionTime,
            truncated: rows.length >= PAGE_SIZE,
            pagination: {
              limit: PAGE_SIZE,
              offset: effectiveOffset,
              totalRows: totalRowCount,
              hasMore: totalRowCount > 0 ? effectiveOffset + rows.length < totalRowCount : false,
              serverSide: true,
              maxClientRows: MAX_CLIENT_ROWS,
            },
          },
        });
      }),
    },
  },
});