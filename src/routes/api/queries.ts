import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import type { ExpressionBuilder } from "kysely";
import type { Database } from "@/lib/db/kysely-db";
import { json } from "@/lib/server/response";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { createLogger } from "@/lib/logging/logger";
import { AUDIT_ACTIONS } from "@/types/actions";
import { LOG_COMPONENTS } from "@/types/components";
import { v4 as uuidv4 } from "uuid";
import { validateQueryAccess } from "@/lib/permissions/query-access-validator";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import type { User } from "@/types/database";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/queries")({
  server: {
    handlers: {
      GET: withApiHandler("/api/queries", async ({ request }) => {
        const logger = createLogger({ component: LOG_COMPONENTS.SAVED_QUERIES_API });
        try {
          const session = await getSession(request);
          if (!session?.user) {
            logger.warn("Unauthorized access attempt to queries list", {
              timestamp: new Date().toISOString(),
              remoteIp: request.headers.get("x-forwarded-for") || "unknown",
            });
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "query", "view");
          if (denied) return denied;

          /*
           * Paginate and search at the database.
           *
           * This selected the whole table and reported `meta.total` as the
           * length of what it had already fetched, so the page it served was
           * always "all of them" — every row, and every row's `sql_content` —
           * while the caller asked for a page. Filtering in the browser has the
           * matching problem: it only ever searches the rows that page happened
           * to contain, so a query whose name matches is invisible unless it
           * landed on the page you were looking at.
           */
          const { searchParams } = new URL(request.url);
          const page = Number.parseInt(searchParams.get("page") || "0", 10);
          const pageSize = Number.parseInt(searchParams.get("pageSize") || "20", 10);
          const search = (searchParams.get("search") || "").trim();
          const like = `%${search}%`;

          const db = getDb();

          // The data source's name is reachable from the search because the
          // browser-side filter this replaces matched on it too.
          const matches = (eb: ExpressionBuilder<Database, "saved_queries">) =>
            eb.or([
              eb("name", "ilike", like),
              eb("description", "ilike", like),
              eb.exists(
                eb
                  .selectFrom("data_sources")
                  .select("data_sources.id")
                  .whereRef("data_sources.id", "=", "saved_queries.data_source_id")
                  .where("data_sources.name", "ilike", like)
              ),
            ]);

          let rowsQuery = db
            .selectFrom("saved_queries")
            .selectAll()
            .orderBy("created_at", "desc")
            // A tie-breaker: rows seeded together share a timestamp, and without one the order of equal rows
            // is not stable between pages, so offset pagination skips some and repeats others.
            .orderBy("id", "desc")
            .limit(pageSize)
            .offset(page * pageSize);
          let countQuery = db
            .selectFrom("saved_queries")
            .select(db.fn.count<number>("id").as("count"));

          if (search) {
            rowsQuery = rowsQuery.where(matches);
            countQuery = countQuery.where(matches);
          }

          const queries = await rowsQuery.execute();
          const total = Number((await countQuery.executeTakeFirstOrThrow()).count);

          logger.info("Queries list retrieved", {
            userId: session.user.id,
            email: session.user.email,
            userName: session.user.name,
            queriesCount: queries.length,
            action: AUDIT_ACTIONS.QUERIES.LIST_RETRIEVED,
            timestamp: new Date().toISOString(),
          });

          return json({
            success: true,
            data: { items: queries, meta: { total, page, pageSize } },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          logger.error(
            "Failed to fetch queries",
            error instanceof Error ? error : new Error(errorMessage),
            {
              errorMessage,
              timestamp: new Date().toISOString(),
            }
          );
          return json(
            { success: false, error: { message: "Failed to fetch queries" } },
            { status: 500 }
          );
        }
      }),
      POST: withApiHandler("/api/queries", async ({ request }) => {
        const logger = createLogger({ component: LOG_COMPONENTS.SAVED_QUERIES_API });
        const startTime = Date.now();
        try {
          const session = await getSession(request);
          if (!session?.user) {
            logger.warn("Unauthorized access attempt to create query", {
              timestamp: new Date().toISOString(),
              remoteIp: request.headers.get("x-forwarded-for") || "unknown",
            });
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "query", "create");
          if (denied) return denied;

          const body = (await request.json()) as {
            name: string;
            description?: string;
            dataSourceId: string;
            sqlContent: string;
          };

          if (!body.name || !body.dataSourceId || !body.sqlContent) {
            logger.warn("Query creation attempted with missing required fields", {
              userId: session.user.id,
              email: session.user.email,
              action: AUDIT_ACTIONS.QUERIES.VALIDATION_FAILED,
              missingFields: {
                name: !body.name,
                dataSourceId: !body.dataSourceId,
                sqlContent: !body.sqlContent,
              },
              timestamp: new Date().toISOString(),
            });
            return json(
              { success: false, error: { message: "Missing required fields" } },
              { status: 400 }
            );
          }

          /*
           * A saved query is SQL that something else will execute later, so it
           * is checked here as strictly as the SQL editor checks what it runs.
           *
           * It was checked nowhere. `POST /api/queries` took `sqlContent` and
           * `dataSourceId` from the body and stored the text verbatim — no
           * read-only test, and no question about whether the caller may read
           * the data source at all — and `POST /api/queries/:id/execute` then
           * ran it without either check. Saving `DELETE FROM users` and calling
           * execute was, between those two routes, a complete write path into
           * every connected database for any account that could sign in.
           *
           * Both ends are checked now. This one refuses the statement; the
           * other refuses the caller at the time of the run, because
           * permissions change between saving a query and running it.
           */
          if (!isReadOnlyQuery(body.sqlContent)) {
            logger.warn("Non-read-only SQL rejected at save time", {
              userId: session.user.id,
              email: session.user.email,
              dataSourceId: body.dataSourceId,
              sqlPreview: body.sqlContent.substring(0, 100),
              timestamp: new Date().toISOString(),
            });
            return json(
              {
                success: false,
                error: {
                  code: "FORBIDDEN",
                  message:
                    "A saved query must be a single SELECT, WITH, EXPLAIN, SHOW or DESCRIBE statement.",
                },
              },
              { status: 403 }
            );
          }

          const saveAccess = await validateQueryAccess(
            session.user as unknown as User,
            body.sqlContent,
            body.dataSourceId
          );
          if (!saveAccess.allowed) {
            logger.warn("Query save denied by entity access rules", {
              userId: session.user.id,
              email: session.user.email,
              dataSourceId: body.dataSourceId,
              deniedTables: saveAccess.deniedTables,
              reason: saveAccess.reason,
              timestamp: new Date().toISOString(),
            });
            return json(
              {
                success: false,
                error: {
                  code: "FORBIDDEN",
                  message:
                    saveAccess.reason || "You do not have access to every table in this query",
                },
              },
              { status: 403 }
            );
          }

          const id = uuidv4();
          const db = getDb();

          logger.info("Query creation started", {
            userId: session.user.id,
            email: session.user.email,
            queryName: body.name,
            dataSourceId: body.dataSourceId,
            action: AUDIT_ACTIONS.QUERIES.CREATE_STARTED,
            timestamp: new Date().toISOString(),
          });

          const now = new Date().toISOString();
          await db
            .insertInto("saved_queries")
            .values({
              id,
              created_by: session.user.id,
              is_validated: false,
              name: body.name,
              description: body.description || null,
              data_source_id: body.dataSourceId,
              sql_content: body.sqlContent,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const executionTime = Date.now() - startTime;
          logger.info("Query created successfully", {
            userId: session.user.id,
            email: session.user.email,
            userName: session.user.name,
            queryId: id,
            queryName: body.name,
            dataSourceId: body.dataSourceId,
            sqlLength: body.sqlContent.length,
            description: body.description,
            action: AUDIT_ACTIONS.QUERIES.CREATE_SUCCESS,
            executionTime,
            timestamp: new Date().toISOString(),
          });

          return json({ success: true, data: { id } }, { status: 201 });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          const executionTime = Date.now() - startTime;
          logger.error(
            "Failed to create query",
            error instanceof Error ? error : new Error(errorMessage),
            {
              errorMessage,
              errorType: error?.constructor?.name,
              action: AUDIT_ACTIONS.QUERIES.CREATE_FAILED,
              executionTime,
              timestamp: new Date().toISOString(),
            }
          );
          return json(
            { success: false, error: { message: "Failed to create query" } },
            { status: 500 }
          );
        }
      }),
    },
  },
});
