import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql as kyselySql } from "kysely";
import { json } from "@/lib/server/response";
import { validateQueryAccess } from "@/lib/permissions/query-access-validator";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import type { DataSource, User } from "@/types/database";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/queries/$id/execute")({
  server: {
    handlers: {
      POST: withApiHandler("/api/queries/$id/execute", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();

          const query = await db
            .selectFrom("saved_queries")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!query) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Query not found" } },
              { status: 404 }
            );
          }

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", query.data_source_id)
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

          /*
           * The caller is checked here, at the run, not only where the query was
           * written.
           *
           * This route used to resolve a saved query by id and execute it on a
           * session check alone — no ownership test, no read-only test, and no
           * `validateQueryAccess`. Any signed-in account could run any saved
           * query belonging to anyone, and since nothing validated the SQL on
           * the way in either, "any saved query" included one the caller had
           * just written to say `DELETE FROM users`.
           *
           * Both checks are repeated here rather than trusted from save time,
           * for two different reasons:
           *
           *   read-only   rows predate this validation, and `sql_content` is an
           *               ordinary column that something other than these routes
           *               may have written.
           *   access      permissions change. A query saved by someone who could
           *               read a table must not keep reading it for someone who
           *               cannot, and the person running it is frequently not
           *               the person who saved it.
           */
          if (!isReadOnlyQuery(query.sql_content)) {
            return json(
              {
                success: false,
                error: {
                  code: "FORBIDDEN",
                  message: "This saved query is not a single read-only statement and was not run.",
                },
              },
              { status: 403 }
            );
          }

          const accessValidation = await validateQueryAccess(
            session.user as unknown as User,
            query.sql_content,
            query.data_source_id
          );
          if (!accessValidation.allowed) {
            return json(
              {
                success: false,
                error: {
                  code: "FORBIDDEN",
                  message:
                    accessValidation.reason ||
                    "You do not have access to every table in this query",
                },
              },
              { status: 403 }
            );
          }

          const { getConnection } = await import("@/lib/db/connection-manager");
          const connection = await getConnection(dataSource as unknown as DataSource);

          const limitedSql = query.sql_content.trim().replace(/;$/, "");
          const sqlToRun = /\bLIMIT\s+\d+/i.test(limitedSql)
            ? limitedSql
            : `${limitedSql} LIMIT 1000`;

          const { rows } = await kyselySql.raw(sqlToRun).execute(connection);
          const typedRows = rows as Record<string, unknown>[];

          const columns: string[] = typedRows.length > 0 ? Object.keys(typedRows[0]) : [];

          return json({
            success: true,
            data: {
              rows: typedRows,
              columns,
              rowCount: typedRows.length,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to execute query");
        }
      }),
    },
  },
});
