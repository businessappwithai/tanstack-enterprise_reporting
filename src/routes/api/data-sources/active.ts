import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  return auth(request);
}

/**
 * A data source as these routes return it: without `connection_config`. That column is
 * the encrypted connection string, password included, and both handlers used to
 * `selectAll()` it into a response any signed-in account could read.
 */
function withoutConnectionConfig<T extends { connection_config?: unknown }>(row: T | null) {
  if (!row) return null;
  const { connection_config: _omitted, ...safe } = row;
  return safe;
}

export const Route = createFileRoute("/api/data-sources/active")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/active", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const db = getDb();

          const dataSources = await db
            .selectFrom("data_sources")
            .where("is_active", "=", true)
            .where("is_deleted", "=", false)
            .selectAll()
            .execute();

          const activeDataSource = withoutConnectionConfig(dataSources[0] ?? null);

          return json({
            success: true,
            data: {
              activeDataSource,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch active data source");
        }
      }),

      POST: withApiHandler("/api/data-sources/active", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const body = (await request.json()) as { dataSourceId: string };
          const { dataSourceId } = body;

          if (!dataSourceId) {
            return json(
              {
                success: false,
                error: { message: "dataSourceId is required" },
              },
              { status: 400 }
            );
          }

          const db = getDb();
          const dataSource = await db
            .selectFrom("data_sources")
            .where("id", "=", dataSourceId)
            .where("is_active", "=", true)
            .where("is_deleted", "=", false)
            .selectAll()
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              {
                success: false,
                error: { message: "Data source not found" },
              },
              { status: 404 }
            );
          }

          return json({
            success: true,
            data: {
              activeDataSource: withoutConnectionConfig(dataSource),
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to set active data source");
        }
      }),
    },
  },
});
