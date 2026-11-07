import { createServerFn } from "@tanstack/react-start";
import type { DatabaseClientType, SerializableValue } from "@/types/database";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  createDataSourceSchema,
  updateDataSourceSchema,
  type CreateDataSourceInput,
  type UpdateDataSourceInput,
} from "@/lib/schemas/data-sources";
import { uuidSchema } from "@/lib/schemas/common";
import { requireAuth } from "@/lib/auth/middleware";
import { getDb } from "@/lib/db/config";
import { logAudit } from "@/lib/security/audit";
import { encrypt, decrypt } from "@/lib/security/encryption";
import { closeConnection } from "@/lib/db/connection-manager";
import { withErrorHandler } from "@/lib/server-fns/with-error-handler";
import { getLogger } from "@/lib/logging/logger";

/** The schema's client names mapped to the values connection-manager switches on. */
function toClientType(clientType: "postgres" | "mysql" | "sqlite3"): DatabaseClientType {
  return clientType === "postgres" ? "pg" : clientType;
}

export const listDataSources = createServerFn({ method: "GET" }).handler(async () => {
  return withErrorHandler(
    async () => {
      const session = await requireAuth();
      const db = getDb();

      const dataSources = await db
        .selectFrom("data_sources")
        .selectAll()
        .where("is_deleted", "=", false)
        .orderBy("name", "asc")
        .execute();

      // Strip sensitive connection_config from list response
      const sanitized = dataSources.map(({ connection_config: _cc, ...rest }) => rest);

      return { items: sanitized, meta: { total: sanitized.length } };
    },
    {
      userId: (await requireAuth()).user.id,
      action: "execute",
      details: { operation: "listDataSources" },
    }
  );
});

export const getDataSource = createServerFn({ method: "GET" })
  .inputValidator(z.object({ id: uuidSchema }))
  .handler(async ({ data: input }) => {
    return withErrorHandler(
      async () => {
        const session = await requireAuth();
        const { id } = input;
        const db = getDb();

        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst();

        if (!dataSource) {
          throw new Error("NOT_FOUND");
        }

        let connectionConfig: Record<string, SerializableValue>;
        try {
          const isEncrypted =
            dataSource.connection_config.length > 64 &&
            /^[0-9a-fA-F]+$/.test(dataSource.connection_config);
          if (isEncrypted) {
            connectionConfig = JSON.parse(decrypt(dataSource.connection_config));
          } else {
            connectionConfig = JSON.parse(dataSource.connection_config);
            // Re-encrypt in background
            const encryptedConfig = encrypt(JSON.stringify(connectionConfig));
            db.updateTable("data_sources")
              .set({ connection_config: encryptedConfig })
              .where("id", "=", id)
              .execute()
              .catch(console.error);
          }
        } catch (decryptError) {
          getLogger("app").event("app.serverfn.failed", { what: "Failed to decrypt connection config", detail: [{ dataSourceId: id }, decryptError] });
          throw decryptError;
        }

        return { ...dataSource, connectionConfig };
      },
      {
        userId: (await requireAuth()).user.id,
        action: "execute",
        details: { operation: "getDataSource", dataSourceId: input.id },
      }
    );
  });

export const createDataSource = createServerFn({ method: "POST" })
  .inputValidator(createDataSourceSchema)
  .handler(async ({ data: input }) => {
    return withErrorHandler(
      async () => {
        const session = await requireAuth();

        const db = getDb();
        const id = randomUUID();
        const encryptedConfig = encrypt(JSON.stringify(input.connectionConfig));
        const now = new Date().toISOString();

        await db
          .insertInto("data_sources")
          .values({
            id,
            name: input.name,
            description: input.description ?? null,
            client_type: toClientType(input.clientType),
            connection_config: encryptedConfig,
            is_active: true,
            is_editable: false,
            is_deleted: false,
            deleted_at: null,
            deleted_by: null,
            created_by: session.user.id,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await logAudit({
          userId: session.user.id,
          action: "create",
          resourceType: "data_source",
          resourceId: id,
          details: { name: input.name, clientType: input.clientType },
        });

        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();

        return dataSource;
      },
      {
        userId: (await requireAuth()).user.id,
        action: "execute",
        details: { operation: "createDataSource", name: input.name },
      }
    );
  });

export const updateDataSource = createServerFn({ method: "POST" })
  .inputValidator(updateDataSourceSchema)
  .handler(async ({ data: input }) => {
    return withErrorHandler(
      async () => {
        const session = await requireAuth();
        const { id } = input;
        const db = getDb();

        const existing = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst();

        if (!existing) {
          throw new Error("NOT_FOUND");
        }

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

        if (input.name !== undefined) updates.name = input.name;
        if (input.description !== undefined) updates.description = input.description;

        if (input.connectionConfig !== undefined) {
          let finalConnectionConfig = input.connectionConfig;
          const configObj = input.connectionConfig as Record<string, SerializableValue>;

          if (!configObj.password) {
            const existingConfig = JSON.parse(decrypt(existing.connection_config));
            finalConnectionConfig = { ...configObj, password: existingConfig.password };
          }

          updates.connection_config = encrypt(JSON.stringify(finalConnectionConfig));
        }

        await db.updateTable("data_sources").set(updates).where("id", "=", id).execute();

        await closeConnection(id);

        await logAudit({
          userId: session.user.id,
          action: "update",
          resourceType: "data_source",
          resourceId: id,
          details: { name: input.name },
        });

        const updatedDataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();

        return updatedDataSource;
      },
      {
        userId: (await requireAuth()).user.id,
        action: "execute",
        details: { operation: "updateDataSource", dataSourceId: input.id },
      }
    );
  });

export const deleteDataSource = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: uuidSchema }))
  .handler(async ({ data: input }) => {
    return withErrorHandler(
      async () => {
        const session = await requireAuth();
        const { id } = input;
        const db = getDb();

        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst();

        if (!dataSource) {
          throw new Error("NOT_FOUND");
        }

        // Count queries, reports, charts that depend on this data source
        const queryCountResult = await db
          .selectFrom("saved_queries")
          .select(db.fn.count<number>("id").as("count"))
          .where("data_source_id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst();
        const queries = Number(queryCountResult?.count ?? 0);

        let reports = 0;
        let charts = 0;
        if (queries > 0) {
          const queryIds = await db
            .selectFrom("saved_queries")
            .select("id")
            .where("data_source_id", "=", id)
            .where("is_deleted", "=", false)
            .execute();
          const qIds = queryIds.map((q) => q.id);

          if (qIds.length > 0) {
            const reportCountResult = await db
              .selectFrom("report_definitions")
              .select(db.fn.count<number>("id").as("count"))
              .where("saved_query_id", "in", qIds)
              .where("is_deleted", "=", false)
              .executeTakeFirst();
            reports = Number(reportCountResult?.count ?? 0);

            const chartCountResult = await db
              .selectFrom("chart_definitions")
              .select(db.fn.count<number>("id").as("count"))
              .where("saved_query_id", "in", qIds)
              .where("is_deleted", "=", false)
              .executeTakeFirst();
            charts = Number(chartCountResult?.count ?? 0);
          }
        }

        if (queries > 0 || reports > 0 || charts > 0) {
          throw new Error(
            `IN_USE: Cannot delete data source in use by ${queries} queries, ${reports} reports, ${charts} charts`
          );
        }

        // Soft delete
        await db
          .updateTable("data_sources")
          .set({
            is_deleted: true,
            is_active: false,
            deleted_at: new Date().toISOString(),
            deleted_by: session.user.id,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", id)
          .execute();

        await closeConnection(id);

        await logAudit({
          userId: session.user.id,
          action: "delete",
          resourceType: "data_source",
          resourceId: id,
        });

        return { success: true };
      },
      {
        userId: (await requireAuth()).user.id,
        action: "execute",
        details: { operation: "deleteDataSource", dataSourceId: input.id },
      }
    );
  });

export const inspectDataSource = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data: { id } }) => {
    return withErrorHandler(
      async () => {
        const session = await requireAuth();
        const db = getDb();

        // Verify data source exists
        const dataSource = await db
          .selectFrom("data_sources")
          .selectAll()
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst();

        if (!dataSource) {
          throw new Error("NOT_FOUND");
        }

        try {
          // Call the internal API endpoint with proper authentication
          const response = await fetch(`http://localhost:3000/api/data-sources/${id}/inspect`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({
              error: { message: `HTTP ${response.status}` },
            }));
            const errorMessage =
              errorData.error?.message || `Failed to inspect schema (HTTP ${response.status})`;
            throw new Error(errorMessage);
          }

          const result = await response.json();
          if (!result.success) {
            throw new Error(result.error?.message || "Failed to inspect schema");
          }

          await logAudit({
            userId: session.user.id,
            action: "inspect",
            resourceType: "data_source",
            resourceId: id,
            details: { entities_count: result.data?.entities_count || 0 },
          });

          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to inspect schema";
          getLogger("app").event("app.serverfn.failed", { what: "Error", detail: [message, { dataSourceId: id }] });
          throw error;
        }
      },
      {
        userId: (await requireAuth()).user.id,
        action: "execute",
        details: { operation: "inspectDataSource", dataSourceId: id },
      }
    );
  });
