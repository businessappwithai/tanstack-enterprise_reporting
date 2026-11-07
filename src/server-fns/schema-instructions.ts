"use server";

/**
 * Schema Instructions Server Functions
 *
 * Manages detailed field and table instructions for LLM context in NL→SQL translation
 */

import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/middleware";
import { getDb } from "@/lib/db/config";
import { logAudit } from "@/lib/security/audit";
import { getLogger } from "@/lib/logging/logger";

export interface FieldInstruction {
  id?: string;
  dataSourceId: string;
  tableName: string;
  fieldName: string;
  fieldType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyField?: string;
  description?: string;
  llmInstructions?: string;
  exampleValues?: string; // JSON array
  constraints?: string; // JSON
  businessMeaning?: string;
}

export interface TableInstruction {
  id?: string;
  dataSourceId: string;
  tableName: string;
  description?: string;
  llmInstructions?: string;
  exampleQueries?: string; // JSON array
  businessDomain?: string;
}

/**
 * Get all schema instructions for a data source
 */
export const getSchemaInstructions = createServerFn({
  method: "GET",
})
  .inputValidator((data: { dataSourceId: string }) => data)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const db = getDb();

    // Verify user has access to this data source
    const dataSource = await db
      .selectFrom("data_sources")
      .selectAll()
      .where("id", "=", input.dataSourceId)
      .executeTakeFirst();

    if (!dataSource) {
      return { success: false, error: "Data source not found" };
    }

    const fieldInstructions = await db
      .selectFrom("schema_field_instructions")
      .selectAll()
      .where("data_source_id", "=", input.dataSourceId)
      .execute();

    const tableInstructions = await db
      .selectFrom("schema_table_instructions")
      .selectAll()
      .where("data_source_id", "=", input.dataSourceId)
      .execute();

    return {
      success: true,
      data: {
        fieldInstructions,
        tableInstructions,
      },
    };
  });

/**
 * Save field instruction
 */
export const saveFieldInstruction = createServerFn({
  method: "POST",
})
  .inputValidator((data: FieldInstruction) => data)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const db = getDb();

    // Verify user is admin
    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", session.user.id as any)
      .executeTakeFirst();

    if (!(user as any)?.is_admin) {
      return { success: false, error: "Only administrators can manage schema instructions" };
    }

    try {
      if (input.id) {
        // Update existing
        await db
          .updateTable("schema_field_instructions")
          .set({
            description: input.description,
            llm_instructions: input.llmInstructions,
            example_values: input.exampleValues,
            constraints: input.constraints,
            business_meaning: input.businessMeaning,
            updated_at: new Date().toISOString(),
            updated_by: session.user.id as any,
          })
          .where("id", "=", input.id)
          .execute();

        await logAudit({
          userId: session.user.id,
          action: "update",
          resourceType: "schema_field_instruction",
          resourceId: input.id,
          details: {
            tableName: input.tableName,
            fieldName: input.fieldName,
          },
        });
      } else {
        // Create new
        await db
          .insertInto("schema_field_instructions")
          .values({
            id: randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            data_source_id: input.dataSourceId,
            table_name: input.tableName,
            field_name: input.fieldName,
            field_type: input.fieldType,
            is_nullable: input.isNullable,
            is_primary_key: input.isPrimaryKey,
            is_foreign_key: input.isForeignKey,
            foreign_key_table: input.foreignKeyTable,
            foreign_key_field: input.foreignKeyField,
            description: input.description,
            llm_instructions: input.llmInstructions,
            example_values: input.exampleValues,
            constraints: input.constraints,
            business_meaning: input.businessMeaning,
            created_by: session.user.id as any,
            updated_by: session.user.id as any,
          })
          .execute();

        await logAudit({
          userId: session.user.id,
          action: "create",
          resourceType: "schema_field_instruction",
          resourceId: `${input.dataSourceId}/${input.tableName}/${input.fieldName}`,
          details: {
            tableName: input.tableName,
            fieldName: input.fieldName,
          },
        });
      }

      return { success: true, data: input };
    } catch (error) {
      getLogger("app").event("app.serverfn.failed", { what: "Save failed", err: error });
      return { success: false, error: error instanceof Error ? error.message : "Failed to save" };
    }
  });

/**
 * Save table instruction
 */
export const saveTableInstruction = createServerFn({
  method: "POST",
})
  .inputValidator((data: TableInstruction) => data)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const db = getDb();

    // Verify user is admin
    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", session.user.id as any)
      .executeTakeFirst();

    if (!(user as any)?.is_admin) {
      return { success: false, error: "Only administrators can manage schema instructions" };
    }

    try {
      if (input.id) {
        // Update existing
        await db
          .updateTable("schema_table_instructions")
          .set({
            description: input.description,
            llm_instructions: input.llmInstructions,
            example_queries: input.exampleQueries,
            business_domain: input.businessDomain,
            updated_at: new Date().toISOString(),
            updated_by: session.user.id as any,
          })
          .where("id", "=", input.id)
          .execute();
      } else {
        // Create new
        await db
          .insertInto("schema_table_instructions")
          .values({
            id: randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            data_source_id: input.dataSourceId,
            table_name: input.tableName,
            description: input.description,
            llm_instructions: input.llmInstructions,
            example_queries: input.exampleQueries,
            business_domain: input.businessDomain,
            created_by: session.user.id as any,
            updated_by: session.user.id as any,
          })
          .execute();
      }

      await logAudit({
        userId: session.user.id,
        action: input.id ? "update" : "create",
        resourceType: "schema_table_instruction",
        resourceId: input.id || `${input.dataSourceId}/${input.tableName}`,
        details: {
          tableName: input.tableName,
        },
      });

      return { success: true, data: input };
    } catch (error) {
      getLogger("app").event("app.serverfn.failed", { what: "Save failed", err: error });
      return { success: false, error: error instanceof Error ? error.message : "Failed to save" };
    }
  });
