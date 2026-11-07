import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { validateQueryAccess } from "@/lib/permissions/query-access-validator";
import { isReadOnlyQuery } from "@/lib/sql/validator";
import type { User } from "@/types/database";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/queries/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/queries/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const db = getDb();
          const query = await db
            .selectFrom("saved_queries")
            .selectAll()
            .where("id", "=", params.id)
            .executeTakeFirst();

          if (!query) {
            return json({ success: false, error: { message: "Query not found" } }, { status: 404 });
          }

          return json({ success: true, data: query });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch query");
        }
      }),
      PUT: withApiHandler("/api/queries/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const body = (await request.json()) as {
            name?: string;
            description?: string;
            dataSourceId?: string;
            sqlContent?: string;
          };

          const db = getDb();

          // Verify ownership (admin can edit any query)
          const existingQuery = await db
            .selectFrom("saved_queries")
            .select("created_by")
            .where("id", "=", params.id)
            .executeTakeFirst();

          if (!existingQuery) {
            return json({ success: false, error: { message: "Query not found" } }, { status: 404 });
          }

          const sessionRoles: string[] = (session.user as any).roles ?? [];
          const isAdmin = sessionRoles.some((r: string) => r.toLowerCase().includes("admin"));
          if (!isAdmin && existingQuery.created_by !== session.user.id) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
          }

          /*
           * An edit can replace the SQL, so it is checked exactly as a create
           * is. Gating only the create would leave the same write path open one
           * verb along: save `SELECT 1`, then PUT the statement you actually
           * wanted.
           *
           * Checked against the data source the query will have after the edit,
           * not the one it had before — those differ when `dataSourceId` moves.
           */
          if (body.sqlContent !== undefined) {
            if (!isReadOnlyQuery(body.sqlContent)) {
              return json(
                {
                  success: false,
                  error: {
                    message:
                      "A saved query must be a single SELECT, WITH, EXPLAIN, SHOW or DESCRIBE statement.",
                  },
                },
                { status: 403 }
              );
            }

            const targetDataSourceId =
              body.dataSourceId ??
              (
                await db
                  .selectFrom("saved_queries")
                  .select("data_source_id")
                  .where("id", "=", params.id)
                  .executeTakeFirst()
              )?.data_source_id;

            if (!targetDataSourceId) {
              return json(
                { success: false, error: { message: "Query has no data source" } },
                { status: 400 }
              );
            }

            const editAccess = await validateQueryAccess(
              session.user as unknown as User,
              body.sqlContent,
              targetDataSourceId
            );
            if (!editAccess.allowed) {
              return json(
                {
                  success: false,
                  error: {
                    message:
                      editAccess.reason || "You do not have access to every table in this query",
                  },
                },
                { status: 403 }
              );
            }
          }

          const updateData: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };

          if (body.name) updateData.name = body.name;
          if (body.description !== undefined) updateData.description = body.description || null;
          if (body.dataSourceId) updateData.data_source_id = body.dataSourceId;
          if (body.sqlContent) updateData.sql_content = body.sqlContent;

          await db
            .updateTable("saved_queries")
            .set(updateData)
            .where("id", "=", params.id)
            .execute();

          return json({ success: true, data: { id: params.id } });
        } catch (error) {
          throw serverFailure(error, "Failed to update query");
        }
      }),
      DELETE: withApiHandler("/api/queries/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const db = getDb();

          // Verify ownership
          const existingQuery = await db
            .selectFrom("saved_queries")
            .select("created_by")
            .where("id", "=", params.id)
            .executeTakeFirst();

          if (!existingQuery) {
            return json({ success: false, error: { message: "Query not found" } }, { status: 404 });
          }

          const deleteRoles: string[] = (session.user as any).roles ?? [];
          const isDeleteAdmin = deleteRoles.some((r: string) => r.toLowerCase().includes("admin"));
          if (!isDeleteAdmin && existingQuery.created_by !== session.user.id) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
          }

          await db.deleteFrom("saved_queries").where("id", "=", params.id).execute();

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete query");
        }
      }),
    },
  },
});
