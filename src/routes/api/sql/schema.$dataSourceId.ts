import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { SyncService } from "@/lib/metadata/sync-service";
import { json } from "@/lib/server/response";
import { introspectSchema } from "@/lib/sql/schema-introspection";
import type { DataSource } from "@/types/database";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/sql/schema/$dataSourceId")({
  server: {
    handlers: {
      GET: withApiHandler("/api/sql/schema/$dataSourceId", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const { dataSourceId } = params;

          const db = getDb();
          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", dataSourceId)
            .where("is_active", "=", true)
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              {
                success: false,
                error: { code: "NOT_FOUND", message: "Data source not found or not active" },
              },
              { status: 404 }
            );
          }

          const connection = await getConnection(dataSource as unknown as DataSource);
          const { schema, logs } = await introspectSchema(connection, dataSource.client_type);

          let syncResult: Awaited<ReturnType<typeof SyncService.syncDataSource>> | undefined;
          try {
            syncResult = await SyncService.syncDataSource(dataSourceId, session.user.id);
          } catch (e) {
            recordFailure(e, "[Schema Sync] Failed to sync metadata:");
          }

          if (schema.tables.length === 0 && schema.views.length === 0) {
            return json({
              success: true,
              data: { ...schema, logs },
              warning:
                "No tables or views found in this database. The database may be empty or you may not have permission to access the tables.",
            });
          }

          return json({
            success: true,
            data: {
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
            },
          });
        } catch (error) {
          recordFailure(error, "Schema introspection error:");
          const errorMessage = error instanceof Error ? error.message : "Unknown error";

          if (errorMessage.includes("SQLITE_CANTOPEN")) {
            return json(
              {
                success: false,
                error: {
                  code: "DATABASE_NOT_FOUND",
                  message:
                    "Database file not found. Please check the file path in the data source configuration.",
                },
              },
              { status: 404 }
            );
          }

          return json(
            {
              success: false,
              error: { code: "INTROSPECTION_ERROR", message: errorMessage },
            },
            { status: 500 }
          );
        }
      }),
    },
  },
});
