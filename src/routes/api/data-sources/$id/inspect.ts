import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { introspectSchema } from "@/lib/sql/schema-introspection";
import type { SchemaInfo } from "@/types/api";
import { randomUUID } from "node:crypto";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/data-sources/$id/inspect")({
  server: {
    handlers: {
      POST: withApiHandler("/api/data-sources/$id/inspect", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const db = getDb();

          // Check if data source exists
          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", params.id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!dataSource) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          // Allow owner or admins to inspect
          const userRoles: string[] = session.user.roles || [];
          const isAdmin = userRoles.some((r) => r.toLowerCase().includes("admin"));
          const isOwner = dataSource.created_by === session.user.id;

          if (!isAdmin && !isOwner) {
            return json({ error: { message: "Forbidden" } }, { status: 403 });
          }

          // Introspect the schema with extended timeout for external databases
          const connection = await getConnection(dataSource);

          // Wrap introspection in a timeout promise (increased for external databases)
          let schema: SchemaInfo;
          try {
            const introspectionPromise = introspectSchema(connection, dataSource.client_type);
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Schema introspection timeout (exceeded 300 seconds)")),
                300000
              )
            );
            const result = await Promise.race([introspectionPromise, timeoutPromise]);
            schema = result.schema;
          } catch (error) {
            if (error instanceof Error && error.message.includes("timeout")) {
              throw new Error(
                `Schema introspection timeout: ${error.message}. This may indicate the database is slow or unreachable.`
              );
            }
            throw error;
          }

          let entitiesCreated = 0;
          const now = new Date().toISOString();

          // Create metadata entities for each table and view
          const tables = schema.tables || [];
          const views = schema.views || [];
          const allEntities = [
            ...tables.map((t: any) => ({ ...t, entity_type: "table" })),
            ...views.map((v: any) => ({ ...v, entity_type: "view" })),
          ];

          for (const entity of allEntities) {
            // Check if entity already exists
            const existing = await db
              .selectFrom("metadata_entity_header")
              .select("id")
              .where("data_source_id", "=", params.id)
              .where("entity_name", "=", entity.name)
              .where((eb) =>
                entity.schema
                  ? eb("entity_schema", "=", entity.schema)
                  : eb("entity_schema", "is", null)
              )
              .executeTakeFirst();

            if (!existing) {
              const headerId = randomUUID();

              // Create entity header
              await db
                .insertInto("metadata_entity_header")
                .values({
                  id: headerId,
                  data_source_id: params.id,
                  entity_name: entity.name,
                  entity_schema: entity.schema || null,
                  entity_type: entity.entity_type,
                  schema_metadata: JSON.stringify(entity),
                  is_active: false,
                  is_hidden: true,
                  created_by: session.user.id,
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              // Create field entries for columns
              const columns = entity.columns || [];
              for (const col of columns) {
                await db
                  .insertInto("metadata_entity_field")
                  .values({
                    id: randomUUID(),
                    entity_header_id: headerId,
                    field_name: col.name,
                    data_type: col.type,
                    is_nullable: col.nullable !== false,
                    is_primary_key: col.isPrimaryKey || false,
                    is_foreign_key: col.isForeignKey || false,
                    foreign_key_table: col.foreignKeyTable || null,
                    foreign_key_column: col.foreignKeyColumn || null,
                    default_value: col.defaultValue || null,
                    is_display_field: false,
                    is_searchable: true,
                    created_at: now,
                    updated_at: now,
                  })
                  .execute();
              }

              entitiesCreated++;
            }
          }

          // Mark as inspected with timestamp
          const inspectedAt = new Date().toISOString();
          await db
            .updateTable("data_sources")
            .set({
              is_inspected: true,
              last_inspected_at: inspectedAt,
              updated_at: inspectedAt,
            } as any)
            .where("id", "=", params.id)
            .execute();

          return json({
            success: true,
            data: {
              entities_count: entitiesCreated,
              total_entities: allEntities.length,
              message: `Schema inspection completed. ${entitiesCreated} new entities imported.`,
            },
          });
        } catch (error) {
          let errorCode = "";
          let errorMessage = "Internal server error";

          // Try to extract code and message from various error formats
          try {
            if (error instanceof Error) {
              errorMessage = error.message || String(error);
              // Check if Error object has code property (from pg)
              errorCode = (error as any).code || "";
            } else if (typeof error === "object" && error !== null) {
              // Try to access code property directly
              errorCode = (error as any).code || (error as any).errno || "";
              errorMessage = (error as any).message || errorCode || String(error);
            } else {
              errorMessage = String(error);
            }

            // Ensure we have some message
            if (!errorMessage || errorMessage === "Unknown error" || errorMessage === "") {
              errorMessage = errorCode || "Unknown error";
            }
          } catch (parseError) {
            recordFailure(parseError, "Error parsing error object:");
            errorMessage = "Failed to inspect schema";
          }

          getLogger("datasource").event("datasource.inspect.failed", { errorCode: String(errorCode ?? "UNKNOWN") });
          recordFailure(error, "Data source inspect failed");

          // Provide helpful error messages for common issues
          let userMessage = errorMessage;

          if (errorCode === "ETIMEDOUT" || errorMessage.includes("ETIMEDOUT")) {
            userMessage =
              "Connection timeout: The database server is not responding. This usually means the server is unreachable or the network is blocking the connection.";
          } else if (errorCode === "ECONNREFUSED" || errorMessage.includes("ECONNREFUSED")) {
            userMessage =
              "Connection refused: The database server rejected the connection. Verify the host, port, and credentials.";
          } else if (errorMessage.includes("timeout")) {
            userMessage = `Schema introspection timeout: The database took too long to respond.`;
          } else if (errorMessage.includes("connect")) {
            userMessage =
              "Failed to connect to the database. The server may be unreachable or the network may be restricted.";
          }

          return json(
            {
              error: {
                message: userMessage || "Failed to inspect schema",
              },
            },
            { status: 500 }
          );
        }
      }),
    },
  },
});
