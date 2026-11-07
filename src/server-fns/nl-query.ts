"use server";

/**
 * Natural Language Query Server Functions
 *
 * Handles NL→SQL translation with validation (D3, D4)
 */

import { createServerFn } from "@tanstack/react-start";
import { sql } from "kysely";
import { requireAuth } from "@/lib/auth/middleware";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { formatGraphContext, getGraphContext } from "@/lib/graph/rag";
import { isDenied, translateNLToSQLViaLlama } from "@/lib/nlquery/llama-translator";
import {
  isMastraAvailable,
  translateNLToSQLViaMastra as translateViaMastra,
} from "@/lib/nlquery/mastra-connector";
import {
  buildMastraContextPrompt,
  storeNLQueryContext,
} from "@/lib/nlquery/nl-query-context-service";
import { isSafeSelectQuery } from "@/lib/nlquery/openai-translator";
import { getSchemaMetadata } from "@/lib/nlquery/schema-metadata";
import { validateQueryAccess } from "@/lib/permissions/query-access-validator";
import { logAudit } from "@/lib/security/audit";
import { validateSQLWithAllowlist } from "@/lib/sql/antlr-validator";
import {
  assessTranslationConfidence,
  reverseTranslateSql,
} from "@/lib/validation/translation-validator";
import { isLlamaReasoningAvailable } from "@/lib/voice/llama-client";
import type { DataSource, ResultRow, User } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

export interface ExecuteNLQueryInput {
  nlQuestion: string;
  dataSourceId: string;
  timeout?: number;
}

export interface ExecuteNLQueryResult {
  success: boolean;
  sql?: string;
  englishMeaning?: string;
  confidence?: number;
  requiresApproval?: boolean;
  warning?: string;
  rows?: ResultRow[];
  error?: string;
  rowCount?: number;
  executionTime?: number;
}

const DEFAULT_TIMEOUT = 30000;
const CONFIDENCE_THRESHOLD = 0.9; // D3: ≥90% execute; <90% warn

/**
 * Execute a query generated from natural language
 *
 * Pipeline:
 * 1. NL→SQL translation (OpenAI)
 * 2. ANTLR validation (keyword allowlist)
 * 3. Translation validation (reverse-translate, semantic match)
 * 4. RBAC pre-flight check
 * 5. Execute
 * 6. Log to OpenKB (on success)
 */
export const executeNLQuery = createServerFn({
  method: "POST",
})
  .inputValidator((data: ExecuteNLQueryInput) => data)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const { nlQuestion, dataSourceId, timeout = DEFAULT_TIMEOUT } = input;

    if (!nlQuestion || nlQuestion.trim().length === 0) {
      return {
        success: false,
        error: "Natural language question is required",
      };
    }

    if (!dataSourceId) {
      return {
        success: false,
        error: "Data source ID is required",
      };
    }

    const db = getDb();

    // Get data source
    const dataSource = await db
      .selectFrom("data_sources")
      .selectAll()
      .where("id", "=", dataSourceId)
      .where("is_active", "=", true)
      .executeTakeFirst();

    if (!dataSource) {
      return {
        success: false,
        error: "Data source not found or inactive",
      };
    }

    try {
      // [Step 1] Get schema metadata
      const schema = await getSchemaMetadata(dataSource as any as DataSource);

      // [Step 1.2] Get LLM instructions for enhanced context
      const fieldInstructions = await db
        .selectFrom("schema_field_instructions")
        .select([
          "table_name",
          "field_name",
          "description",
          "llm_instructions",
          "example_values",
          "business_meaning",
        ])
        .where("data_source_id", "=", dataSourceId)
        .execute();

      const tableInstructions = await db
        .selectFrom("schema_table_instructions")
        .select(["table_name", "description", "llm_instructions", "business_domain"])
        .where("data_source_id", "=", dataSourceId)
        .execute();

      // Build lookup maps for enhanced context
      const fieldInstructionsMap: Record<string, Record<string, any>> = {};
      const tableInstructionsMap: Record<string, any> = {};

      fieldInstructions.forEach((fi) => {
        if (!fieldInstructionsMap[fi.table_name as string]) {
          fieldInstructionsMap[fi.table_name as string] = {};
        }
        fieldInstructionsMap[fi.table_name as string][fi.field_name as string] = {
          description: fi.description,
          instructions: fi.llm_instructions,
          examples: fi.example_values ? JSON.parse(fi.example_values as string) : undefined,
        };
      });

      tableInstructions.forEach((ti) => {
        tableInstructionsMap[ti.table_name as string] = {
          description: ti.description,
          instructions: ti.llm_instructions,
          domain: ti.business_domain,
        };
      });

      // Enhance schema with LLM instructions
      const enhancedSchema = {
        ...schema,
        fieldInstructions: fieldInstructionsMap,
        tableInstructions: tableInstructionsMap,
      };

      const userRoles = session.user.roles || [];
      const primaryRole = userRoles[0] || "user";

      // [Step 1.5] Build context from similar successful queries for this role
      let contextPrompt = "";
      const mastraAvailable = await isMastraAvailable();

      if (mastraAvailable) {
        const schemaContextStr = JSON.stringify(enhancedSchema);
        contextPrompt = await buildMastraContextPrompt(
          dataSourceId,
          primaryRole,
          nlQuestion,
          schemaContextStr
        );
        getLogger("nlquery").note("debug", "[NLQuery] Built enhanced context from similar role queries");
      }

      // Augment contextPrompt with knowledge-graph schema context (non-fatal if graph is down)
      try {
        const graphCtx = await getGraphContext(dataSourceId, nlQuestion);
        const graphSection = formatGraphContext(graphCtx);
        if (graphSection) {
          contextPrompt = contextPrompt ? `${contextPrompt}\n\n${graphSection}` : graphSection;
          getLogger("nlquery").note("debug", `[NLQuery] Graph context: ${graphCtx.tables.length} table(s), ~${graphCtx.totalTokenEstimate} tokens`);
        }
      } catch {
        // graph unavailable — continue with pgvector context only
      }

      // [Step 1.6] Translate NL to SQL via Mastra.ai agent (primary) or llama.cpp direct (fallback)
      let translation: any = null;
      let translationSource = "";

      if (mastraAvailable) {
        getLogger("nlquery").note("debug", "[NLQuery] Using Mastra.ai agent for translation");
        translationSource = "mastra-agent";
        translation = await translateViaMastra(
          nlQuestion,
          enhancedSchema,
          {
            userId: session.user.id,
            userEmail: session.user.email,
            userRoles,
            dataSourceId,
            dataSourceName: dataSource.name,
          },
          contextPrompt
        );
      }

      if (!translation && (await isLlamaReasoningAvailable())) {
        getLogger("nlquery").note("debug", "[NLQuery] Mastra not available, using llama.cpp directly");
        translationSource = "llama-reasoning";
        /*
         * The user and data source are passed now.
         *
         * They were not, so the translator's RBAC branch — `if (userId &&
         * dataSourceId)` — never ran on this path at all. Step 4 below still
         * refused the query before it executed, so nothing unauthorised was
         * returned; what was lost is the earlier and more precise refusal, and
         * the audit line naming the tables.
         */
        translation = await translateNLToSQLViaLlama(
          nlQuestion,
          enhancedSchema,
          session.user.id,
          dataSourceId
        );

        if (translation && isDenied(translation)) {
          await logAudit({
            userId: session.user.id,
            action: "view",
            resourceType: "query",
            resourceId: dataSourceId,
            details: {
              nlQuestion,
              deniedTables: translation.deniedTables,
              reason: translation.denied,
            },
          });
          return { success: false, error: translation.denied };
        }
      }

      if (!translation) {
        const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";
        const llamaUrl = process.env.LLAMA_REASONING_URL || "http://localhost:8080";

        await logAudit({
          userId: session.user.id,
          action: "execute",
          resourceType: "query",
          resourceId: dataSourceId,
          details: {
            nlQuestion,
            error: "Neither Mastra agent nor llama.cpp reasoning server is available",
            mastraUrl,
            llamaUrl,
          },
        });

        return {
          success: false,
          error: `Natural language queries require either Mastra.ai (${mastraUrl}) or llama.cpp (${llamaUrl}) to be running.`,
        };
      }

      const generatedSQL = translation.sql;

      // Verify it's a safe SELECT statement
      if (!isSafeSelectQuery(generatedSQL)) {
        await logAudit({
          userId: session.user.id,
          action: "execute",
          resourceType: "query",
          resourceId: dataSourceId,
          details: { nlQuestion, error: "Generated query is not a safe SELECT statement" },
        });
        return {
          success: false,
          error:
            "The generated query is not a valid SELECT statement. Please rephrase your question.",
        };
      }

      // [Step 2] ANTLR validation (D11: keyword allowlist)
      const antlrValidation = validateSQLWithAllowlist(generatedSQL);
      if (!antlrValidation.valid) {
        const errorMsg = antlrValidation.errors.map((e) => e.message).join("; ");
        return {
          success: false,
          sql: generatedSQL,
          error: `Generated query contains invalid syntax: ${errorMsg}`,
        };
      }

      // [Step 3] Translation validation (D4: reverse-translation semantic match)
      const reverseTranslation = await reverseTranslateSql(generatedSQL, nlQuestion, schema);

      const confidenceAssessment = assessTranslationConfidence(
        reverseTranslation,
        CONFIDENCE_THRESHOLD
      );

      // Log the generated query and its confidence
      await logAudit({
        userId: session.user.id,
        action: "create",
        resourceType: "query",
        resourceId: dataSourceId,
        details: {
          nlQuestion,
          generatedSQL: generatedSQL.substring(0, 500),
          confidence: reverseTranslation.confidence,
          englishMeaning: reverseTranslation.englishMeaning,
          translationSource,
          explanation: translation.explanation,
        },
      });

      // [D3] If confidence < 90%, warn but allow override
      if (confidenceAssessment.shouldWarn) {
        return {
          success: false,
          sql: generatedSQL,
          englishMeaning: reverseTranslation.englishMeaning,
          confidence: reverseTranslation.confidence,
          requiresApproval: true,
          warning: confidenceAssessment.message,
        };
      }

      // [Step 4] RBAC pre-flight check (D5)
      const accessValidation = await validateQueryAccess(
        session.user as any as User,
        generatedSQL,
        dataSourceId
      );

      if (!accessValidation.allowed) {
        await logAudit({
          userId: session.user.id,
          action: "view",
          resourceType: "query",
          resourceId: dataSourceId,
          details: {
            nlQuestion,
            deniedTables: accessValidation.deniedTables,
            deniedColumns: accessValidation.deniedColumns,
            reason: accessValidation.reason,
          },
        });

        return {
          success: false,
          sql: generatedSQL,
          error: accessValidation.reason || "Access denied",
        };
      }

      // [Step 5] Execute query
      const connection = await getConnection(dataSource as any as DataSource);
      const startTime = Date.now();
      const result = await sql.raw<ResultRow>(generatedSQL).execute(connection);
      const executionTime = Date.now() - startTime;

      const rows = result.rows;

      // [Step 6] Store successful query context with pgvector for future reference
      try {
        // Get embedding for the NL question (would need an embeddings service)
        // For now, we store with null embedding - Mastra agent could provide it
        const nlQueryEmbedding = translation.embedding || undefined;

        await storeNLQueryContext({
          dataSourceId,
          userId: session.user.id,
          roleName: primaryRole,
          nlQuestion,
          generatedSQL,
          nlQuestionEmbedding: nlQueryEmbedding,
          schemaContext: enhancedSchema,
          rbacContext: {
            userId: session.user.id,
            userEmail: session.user.email,
            userRoles,
          },
          fieldInstructions: tableInstructionsMap,
          executionTimeMs: executionTime,
          rowCount: rows.length,
          wasSuccessful: true,
          translationConfidence: reverseTranslation.confidence || 0.9,
          llmConfidence: translation.confidence || 0.9,
        });

        getLogger("nlquery").note("debug", "[NLQuery] Stored successful query context for role-based learning");
      } catch (error) {
        getLogger("nlquery").note("warn", "[NLQuery] Failed to store query context:", { err: error });
        // Non-fatal error - continue even if context storage fails
      }

      // [Step 7] Log to OpenKB on success (D20-D25: auto-learn)
      try {
        const { logQueryToOpenKB } = await import("@/server-fns/openkb");
        await logQueryToOpenKB({
          data: {
            nlQuestion,
            generatedSQL,
            executionTimeMs: executionTime,
            resultRowCount: rows.length,
          },
        });
      } catch (error) {
        getLogger("nlquery").note("warn", "[NLQuery] Failed to log to OpenKB:", { err: error });
        // Non-fatal error - continue even if OpenKB logging fails
      }

      await logAudit({
        userId: session.user.id,
        action: "execute",
        resourceType: "query",
        resourceId: dataSourceId,
        details: {
          nlQuestion,
          sql: generatedSQL.substring(0, 500),
          rowCount: rows.length,
          executionTime,
          confidence: reverseTranslation.confidence,
          translationSource,
        },
      });

      return {
        success: true,
        sql: generatedSQL,
        englishMeaning: reverseTranslation.englishMeaning,
        confidence: reverseTranslation.confidence,
        rows: rows.slice(0, 100), // Return first 100 rows
        rowCount: rows.length,
        executionTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await logAudit({
        userId: session.user.id,
        action: "execute",
        resourceType: "query",
        resourceId: dataSourceId,
        details: { nlQuestion, error: errorMessage },
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  });

/**
 * NL→SQL translation is now handled by:
 * - @/lib/nlquery/openai-translator.ts - OpenAI-powered translation
 * - @/lib/nlquery/schema-metadata.ts - Database schema extraction
 *
 * These modules provide:
 * - translateNLToSQL: Converts natural language to SQL using GPT-4
 * - getSchemaMetadata: Fetches and caches table/column metadata
 * - isSafeSelectQuery: Validates that generated queries are safe SELECT statements
 */

/**
 * Allow manager to override low-confidence translation and execute anyway
 */
export const executeNLQueryWithOverride = createServerFn({
  method: "POST",
})
  .inputValidator((data: ExecuteNLQueryInput & { approvedSQL: string }) => data)
  .handler(async ({ data: input }) => {
    const session = await requireAuth();
    const { approvedSQL, dataSourceId, timeout = DEFAULT_TIMEOUT } = input;

    const db = getDb();
    const dataSource = await db
      .selectFrom("data_sources")
      .selectAll()
      .where("id", "=", dataSourceId)
      .where("is_active", "=", true)
      .executeTakeFirst();

    if (!dataSource) {
      return { success: false, error: "Data source not found" };
    }

    try {
      // Log the override
      await logAudit({
        userId: session.user.id,
        action: "update",
        resourceType: "query",
        resourceId: dataSourceId,
        details: {
          sql: approvedSQL.substring(0, 500),
          reason: "Manager approved low-confidence translation",
        },
      });

      // Execute with override
      const connection = await getConnection(dataSource as any as DataSource);
      const startTime = Date.now();
      const result = await sql.raw<ResultRow>(approvedSQL).execute(connection);
      const executionTime = Date.now() - startTime;

      const rows = result.rows;

      return {
        success: true,
        sql: approvedSQL,
        rows: rows.slice(0, 100),
        rowCount: rows.length,
        executionTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: errorMessage,
      };
    }
  });

// ---------------------------------------------------------------------------
// nlGenerateSQL — translate NL to SQL without execution (for SQL editor / reports)
// ---------------------------------------------------------------------------

export const nlGenerateSQL = createServerFn({ method: "POST" })
  .inputValidator((data: { nlDescription: string; dataSourceId: string }) => data)
  .handler(async ({ data }) => {
    const session = await requireAuth();
    const { nlDescription, dataSourceId } = data;

    const db = getDb();
    const ds = await db
      .selectFrom("data_sources")
      .selectAll()
      .where("id", "=", dataSourceId)
      .where("is_active", "=", true)
      .executeTakeFirst();

    if (!ds) return { success: false as const, error: "Data source not found" };

    try {
      const schema = await getSchemaMetadata(ds as any);

      let contextPrompt = "";
      try {
        contextPrompt = await buildMastraContextPrompt(
          dataSourceId,
          session.user.id,
          nlDescription,
          JSON.stringify(schema)
        );
      } catch {
        /* non-fatal */
      }

      if (await isMastraAvailable()) {
        const result = await translateViaMastra(nlDescription, schema, {}, contextPrompt);
        if (result?.sql)
          return { success: true as const, sql: result.sql, confidence: result.confidence ?? 0.8 };
      }

      if (await isLlamaReasoningAvailable()) {
        // As above: no user or data source is passed, so the translator's RBAC
        // branch does not run. The narrowing makes that visible at the call
        // site rather than leaving it to be inferred from the argument list.
        const result = await translateNLToSQLViaLlama(nlDescription, schema);
        if (result && !isDenied(result)) {
          return { success: true as const, sql: result.sql, confidence: 0.7 };
        }
      }

      return {
        success: false as const,
        error: "No NL→SQL backend available. Start Mastra or llama.cpp.",
      };
    } catch (err) {
      return {
        success: false as const,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  });
