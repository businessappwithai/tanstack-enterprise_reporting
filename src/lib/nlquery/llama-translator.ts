/**
 * llama.cpp + Qwen3.6 NL→SQL Translator
 *
 * Uses llama.cpp servers with OpenAI-compatible /v1/chat/completions API
 * for natural language to SQL translation
 */

import { validateSQLRBACAccess } from "@/lib/nlquery/sql-ast-validator";
import type { SchemaMetadata } from "@/lib/validation/translation-validator";
import { createReasoningClient, isLlamaReasoningAvailable } from "@/lib/voice/llama-client";
import { getLogger } from "@/lib/logging/logger";

const LLAMA_REASONING_MODEL = process.env.LLAMA_REASONING_MODEL || "qwen3.6";

export interface EnhancedSchemaMetadata extends SchemaMetadata {
  tableInstructions?: Record<
    string,
    { description?: string; instructions?: string; domain?: string }
  >;
  fieldInstructions?: Record<
    string,
    Record<string, { description?: string; instructions?: string; examples?: string[] }>
  >;
}

/**
 * Translate NL to SQL using llama.cpp Qwen3.6
 */
/** A refusal, distinct from a failure to translate. */
export interface LlamaTranslationDenied {
  denied: string;
  deniedTables: string[];
}

export type LlamaTranslation =
  | { sql: string; explanation: string; warnings?: string[] }
  | LlamaTranslationDenied;

/** Narrow a result the caller got back. */
export function isDenied(result: LlamaTranslation | null): result is LlamaTranslationDenied {
  return result !== null && "denied" in result;
}

export async function translateNLToSQLViaLlama(
  nlQuestion: string,
  schema: EnhancedSchemaMetadata,
  userId?: string,
  dataSourceId?: string
): Promise<LlamaTranslation | null> {
  try {
    const available = await isLlamaReasoningAvailable();
    if (!available) {
      getLogger("nlquery").note("warn", "[Llama] Reasoning server not available");
      return null;
    }

    const schemaContext = buildSchemaContext(schema);

    // Step 1: Generate initial SQL via llama.cpp
    const initialSQL = await generateSQLViaLlama(nlQuestion, schemaContext);
    if (!initialSQL) {
      return null;
    }

    // Step 2: Validate the generated SQL
    const validationResult = validateGeneratedSQL(initialSQL);

    if (!validationResult.isValid && validationResult.errors.length > 0) {
      // Step 3: Refine SQL if validation fails
      const refinedSQL = await refineSQLViaLlama(
        nlQuestion,
        initialSQL,
        validationResult.errors,
        schemaContext
      );

      if (!refinedSQL) {
        return null;
      }

      // Validate RBAC on refined SQL if user context provided
      if (userId && dataSourceId) {
        const rbacValidation = await validateSQLRBACAccess(userId, dataSourceId, refinedSQL);
        if (!rbacValidation.accessAllowed) {
          getLogger("nlquery").note("warn", "[Llama] RBAC validation failed for refined SQL:", { detail: [rbacValidation.error] });
          return {
            denied: rbacValidation.error ?? "Access denied",
            deniedTables: rbacValidation.deniedTables,
          };
        }
      }

      return {
        sql: refinedSQL,
        explanation: `Refined SQL after validation: ${validationResult.errors.join(", ")}`,
        warnings: ["SQL was refined due to initial validation errors"],
      };
    }

    /*
     * Step 3: RBAC.
     *
     * This used to log the verdict and return the SQL anyway, which made the
     * check decorative: the caller got a query naming tables the user may not
     * read, and only a later gate — or, on the voice path, nothing at all —
     * stopped it. Handing back SQL that names forbidden tables discloses the
     * shape of the schema and of somebody else's permissions even when it
     * cannot be run.
     *
     * The refusal is its own shape rather than `null`, because "you may not
     * read bus_account" and "the model could not write a query" are different
     * things to tell somebody, and `null` already means the second.
     */
    const warnings: string[] = [];
    if (userId && dataSourceId) {
      const rbacValidation = await validateSQLRBACAccess(userId, dataSourceId, initialSQL);
      if (!rbacValidation.accessAllowed) {
        getLogger("nlquery").note("warn", "[Llama] RBAC validation failed:", { detail: [rbacValidation.error] });
        return {
          denied: rbacValidation.error ?? "Access denied",
          deniedTables: rbacValidation.deniedTables,
        };
      }
    }

    return {
      sql: initialSQL,
      explanation: "SQL generated via Qwen3.6 + llama.cpp",
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    getLogger("nlquery").note("error", "[Llama] Translation failed:", { err: error });
    return null;
  }
}

/**
 * Generate SQL using llama.cpp Qwen3.6 via /v1/chat/completions
 */
async function generateSQLViaLlama(
  nlQuestion: string,
  schemaContext: string
): Promise<string | null> {
  const client = createReasoningClient();

  const systemPrompt = `You are an expert SQL query generator for database analysis and reporting.
Your task is to convert natural language questions into accurate SQL queries.

RULES:
- Generate ONLY SELECT queries with no mutations (no INSERT, UPDATE, DELETE, DROP, etc.)
- Use ONLY the tables and columns provided in the schema below
- Do not use SELECT * unless explicitly requested
- Return ONLY the SQL query with no explanation or markdown code fences
- If a question cannot be answered with the provided schema, respond with "UNABLE_TO_GENERATE"`;

  const userPrompt = `SCHEMA:
${schemaContext}

Question: ${nlQuestion}

Generate a SQL SELECT query that answers this question:`;

  try {
    const response = await client.chat.completions.create({
      model: LLAMA_REASONING_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const content = response.choices[0];
    if (content.message.content === null) {
      return null;
    }

    const raw = content.message.content.trim();

    // Check for inability to generate
    if (raw.includes("UNABLE_TO_GENERATE")) {
      getLogger("nlquery").note("warn", "[Llama] Model indicated inability to generate SQL");
      return null;
    }

    // Strip markdown code fences if present
    const stripped = raw
      .replace(/^```sql\s*/i, "")
      .replace(/```$/, "")
      .trim();

    // Extract SELECT statement (handles leading whitespace, CTEs, etc.)
    const sqlMatch = stripped.match(/(WITH\s+.+?SELECT.+|SELECT.+)/is);
    return sqlMatch ? sqlMatch[0].trim() : null;
  } catch (error) {
    getLogger("nlquery").note("error", "[Llama] SQL generation failed:", { err: error });
    return null;
  }
}

/**
 * Refine SQL based on validation errors
 */
async function refineSQLViaLlama(
  nlQuestion: string,
  previousSQL: string,
  errors: string[],
  schemaContext: string
): Promise<string | null> {
  const client = createReasoningClient();

  const systemPrompt = `You are an expert SQL query generator. Fix SQL query errors.
Return ONLY the corrected SQL query with no explanation or markdown code fences.`;

  const userPrompt = `Original question: "${nlQuestion}"
Previous SQL: ${previousSQL}
Errors found: ${errors.join(", ")}

SCHEMA:
${schemaContext}

Generate a corrected SQL SELECT query (SELECT only, no mutations):`;

  try {
    const response = await client.chat.completions.create({
      model: LLAMA_REASONING_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const content = response.choices[0];
    if (content.message.content === null) {
      return null;
    }

    const raw = content.message.content
      .trim()
      .replace(/^```sql\s*/i, "")
      .replace(/```$/, "")
      .trim();
    const sqlMatch = raw.match(/(WITH\s+.+?SELECT.+|SELECT.+)/is);
    return sqlMatch ? sqlMatch[0].trim() : null;
  } catch (error) {
    getLogger("nlquery").note("error", "[Llama] SQL refinement failed:", { err: error });
    return null;
  }
}

/**
 * Validate generated SQL structure
 */
function validateGeneratedSQL(sql: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check if it's a SELECT statement
  if (!sql.trim().toUpperCase().startsWith("SELECT")) {
    errors.push("Query must be a SELECT statement");
  }

  // Check for dangerous keywords
  const dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE"];
  for (const keyword of dangerous) {
    if (sql.toUpperCase().includes(keyword)) {
      errors.push(`Dangerous keyword found: ${keyword}`);
    }
  }

  // Check for basic syntax
  if (!sql.includes("FROM") && !sql.toUpperCase().includes("FROM")) {
    errors.push("Missing FROM clause");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Build schema context as CREATE TABLE statements
 */
const MAX_TABLES = 40;

function buildSchemaContext(schema: EnhancedSchemaMetadata): string {
  if (!schema.tables || schema.tables.length === 0) {
    return "-- No tables available in schema.";
  }

  const tables = schema.tables.slice(0, MAX_TABLES);

  return tables
    .map((table) => {
      const tableInstr = schema.tableInstructions?.[table.name];
      const comment = tableInstr?.description ? `-- ${tableInstr.description}\n` : "";

      const cols = (table.columns ?? [])
        .map((col) => {
          const colName = typeof col === "object" && col !== null ? col.name : String(col);
          const colType =
            typeof col === "object" && col !== null && "type" in col
              ? (col as { name: string; type: string }).type
              : "text";

          const fieldInstr = schema.fieldInstructions?.[table.name]?.[colName];
          const inlineComment = fieldInstr?.description ? ` -- ${fieldInstr.description}` : "";
          return `  ${colName} ${colType}${inlineComment}`;
        })
        .join(",\n");

      return `${comment}CREATE TABLE ${table.name} (\n${cols}\n);`;
    })
    .join("\n\n");
}
