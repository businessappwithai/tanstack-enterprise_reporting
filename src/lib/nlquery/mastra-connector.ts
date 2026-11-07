/**
 * Mastra.ai Agent Connector
 *
 * Connects to a running Mastra.ai server for NL→SQL translation
 * Enhanced with pgvector context for improved accuracy
 */

import type { SchemaMetadata } from "@/lib/validation/translation-validator";
import { buildMastraContextPrompt } from "./nl-query-context-service";
import { getLogger } from "@/lib/logging/logger";

export interface MastraAgentRequest {
  nlQuestion: string;
  schema: SchemaMetadata;
  context?: Record<string, unknown>;
  contextPrompt?: string; // Enhanced context with similar successful queries
}

export interface MastraAgentResponse {
  sql: string;
  explanation: string;
  confidence?: number;
  warnings?: string[];
  canExecute?: boolean; // Whether the query should be allowed based on RBAC
  executionReason?: string; // Why it can/can't be executed
}

function getMastraHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.MASTRA_API_KEY;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function getModelConfig() {
  return {
    reasoningModel: process.env.AI_NL2SQL_MODEL ?? process.env.LLAMA_REASONING_MODEL ?? "qwen3.6",
    sttModel: process.env.AI_STT_MODEL ?? process.env.LLAMA_STT_MODEL ?? "Qwen3-ASR",
    ttsModel: process.env.AI_TTS_MODEL ?? process.env.LLAMA_TTS_MODEL ?? "Qwen3-TTS",
  };
}

/**
 * Check if Mastra agent is available
 */
export async function isMastraAvailable(): Promise<boolean> {
  const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${mastraUrl}/health`, {
      headers: getMastraHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Translate NL to SQL using Mastra.ai agent with enhanced context
 */
export async function translateNLToSQLViaMastra(
  nlQuestion: string,
  schema: SchemaMetadata,
  context?: Record<string, unknown>,
  contextPrompt?: string
): Promise<MastraAgentResponse | null> {
  const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";

  try {
    // Include pgvector-enhanced context if provided
    const enhancedContext = contextPrompt
      ? {
          ...context,
          contextFromSimilarQueries: contextPrompt,
        }
      : context;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`${mastraUrl}/api/nl-to-sql`, {
      method: "POST",
      headers: getMastraHeaders(),
      body: JSON.stringify({
        nlQuestion,
        schema,
        context: enhancedContext,
        modelConfig: getModelConfig(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      getLogger("nlquery").note("error", `[Mastra] Translation failed with status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as MastraAgentResponse;
    return data;
  } catch (error) {
    getLogger("nlquery").note("error", "[Mastra] Connection error:", { err: error });
    return null;
  }
}

/**
 * Validate SQL using Mastra.ai
 */
export async function validateSQLViaMastra(
  sql: string
): Promise<{ isValid: boolean; errors: string[] }> {
  const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${mastraUrl}/api/validate-sql`, {
      method: "POST",
      headers: getMastraHeaders(),
      body: JSON.stringify({ sql }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { isValid: false, errors: ["Validation failed"] };
    }

    const data = (await response.json()) as { isValid: boolean; errors?: string[] };
    return { ...data, errors: data.errors || [] };
  } catch (error) {
    getLogger("nlquery").note("error", "[Mastra] Validation error:", { err: error });
    return { isValid: false, errors: ["Validation service unavailable"] };
  }
}
