/**
 * OpenAI-powered NL→SQL Translator
 *
 * Converts natural language questions to SQL using OpenAI's GPT-4 model.
 * Uses function calling for structured SQL output with explanations.
 */

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { SchemaMetadata } from "@/lib/validation/translation-validator";
import { getLogger } from "@/lib/logging/logger";

const TranslationResult = z.object({
  sql: z
    .string()
    .describe("The generated SQL query. Must be a valid SELECT statement with no mutations."),
  explanation: z
    .string()
    .describe("Brief explanation of what the query does and how it answers the question"),
  warnings: z
    .array(z.string())
    .optional()
    .describe("Any warnings or assumptions made during translation"),
});

/**
 * Generate SQL from natural language question using OpenAI
 *
 * Prompts GPT-4 with the NL question, database schema, and strict constraints
 * to generate safe, correct SQL queries.
 */
export async function translateNLToSQL(
  nlQuestion: string,
  schema: SchemaMetadata
): Promise<{ sql: string; explanation: string; warnings?: string[] } | null> {
  if (!process.env.OPENAI_API_KEY) {
    getLogger("nlquery").event("nlquery.translate.degraded", { what: "OPENAI_API_KEY not set, cannot translate" });
    return null;
  }

  try {
    // Build schema context from metadata
    const schemaContext = buildSchemaContext(schema);

    const systemPrompt = `You are an expert SQL query generator. Your task is to convert natural language questions into SQL SELECT statements.

STRICT REQUIREMENTS:
1. ONLY generate SELECT queries - absolutely NO INSERT, UPDATE, DELETE, DROP, or other mutation statements
2. Use only the tables and columns provided in the schema below
3. Handle NULL values appropriately
4. Assume standard SQL syntax (works across PostgreSQL and SQLite)
5. Provide clear explanations of what the query does

DATABASE SCHEMA:
${schemaContext}

When the user asks a question, generate the most accurate SQL query that answers it.
Return ONLY SELECT statements. If a query is impossible given the schema, return null.`;

    const result = await generateObject({
      model: openai("gpt-4-turbo"),
      schema: TranslationResult,
      system: systemPrompt,
      prompt: `User question: "${nlQuestion}"

Generate a SQL SELECT query that answers this question using ONLY the schema provided above.
If the question cannot be answered with the available schema, explain why.`,
      temperature: 0.3,
    });

    return {
      sql: result.object.sql,
      explanation: result.object.explanation,
      warnings: result.object.warnings,
    };
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "OpenAI translation failed", err: error });
    return null;
  }
}

/**
 * Build schema context string from metadata for use in prompts
 */
function buildSchemaContext(schema: SchemaMetadata): string {
  if (!schema.tables || schema.tables.length === 0) {
    return "No tables available in schema.";
  }

  return schema.tables
    .map((table) => {
      const columns = table.columns ? table.columns.map((c) => `  - ${c}`).join("\n") : "";
      return `Table: ${table.name}\n${columns}`;
    })
    .join("\n\n");
}

/**
 * Validate that a SQL query is a safe SELECT statement
 * (additional validation beyond ANTLR checks)
 */
export function isSafeSelectQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();

  // Must start with SELECT, WITH, or EXPLAIN
  if (!trimmed.match(/^(SELECT|WITH|EXPLAIN)/)) {
    return false;
  }

  // Must not contain forbidden keywords
  const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "PRAGMA"];
  for (const keyword of forbidden) {
    if (trimmed.includes(keyword)) {
      return false;
    }
  }

  return true;
}
