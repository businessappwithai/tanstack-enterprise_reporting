"use server";

/**
 * OpenKB Server Functions
 *
 * Handles query logging, suggestion, and discovery (D20-D25)
 */

import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/middleware";
import { getOpenKBClient } from "@/lib/openkb/openkb-client";
import { logAudit } from "@/lib/security/audit";
import { getLogger } from "@/lib/logging/logger";

export interface LogQueryInput {
  nlQuestion: string;
  generatedSQL: string;
  executionTimeMs: number;
  resultRowCount: number;
}

export interface SuggestRAGInput {
  proposedDefinition: string;
}

export interface SuggestRAGResult {
  suggestions: Array<{
    nlQuestion: string;
    generatedSQL: string;
    similarity: number;
    executionTimeMs: number;
    resultRowCount: number;
  }>;
}

/**
 * Log a successful query to OpenKB (D20: auto-learn from all successful queries)
 */
export const logQueryToOpenKB = createServerFn({
  method: "POST",
})
  .inputValidator((data: LogQueryInput) => data)
  .handler(async ({ data: input }): Promise<{ queryId: string }> => {
    const session = await requireAuth();

    try {
      const openkb = await getOpenKBClient();

      // Get the manager's role (for role-scoped OpenKB)
      const roleId = session.user.roles[0] ?? "default";

      // Log to OpenKB
      const queryId = await openkb.logQuery(roleId, {
        nlQuestion: input.nlQuestion,
        generatedSQL: input.generatedSQL,
        executionTimeMs: input.executionTimeMs,
        resultRowCount: input.resultRowCount,
      });

      // Audit log
      await logAudit({
        userId: session.user.id,
        action: "openkb_query_logged",
        resourceType: "query",
        resourceId: queryId,
        details: {
          nlQuestion: input.nlQuestion,
          resultRowCount: input.resultRowCount,
        },
      });

      return { queryId };
    } catch (error) {
      getLogger("nlquery").note("error", "[OpenKB] Failed to log query:", { err: error });
      throw new Error("Failed to save query to knowledge base");
    }
  });

/**
 * Suggest similar queries from OpenKB when manager adds RAG context (D24)
 */
export const suggestFromOpenKB = createServerFn({
  method: "POST",
})
  .inputValidator((data: SuggestRAGInput) => data)
  .handler(async ({ data: input }): Promise<SuggestRAGResult> => {
    const session = await requireAuth();

    try {
      const openkb = await getOpenKBClient();
      const roleId = session.user.roles[0] ?? "default";

      // Find similar queries in OpenKB (D24: top 3 suggestions)
      const similar = await openkb.findSimilar(roleId, input.proposedDefinition, 3);

      // Audit log
      await logAudit({
        userId: session.user.id,
        action: "openkb_suggestions_requested",
        resourceType: "rag_context",
        resourceId: roleId,
        details: {
          proposedDefinition: input.proposedDefinition.substring(0, 200),
          suggestionCount: similar.length,
        },
      });

      return {
        suggestions: similar.map((s) => ({
          nlQuestion: s.nlQuestion,
          generatedSQL: s.generatedSQL,
          similarity: s.similarity,
          executionTimeMs: s.executionTimeMs,
          resultRowCount: s.resultRowCount,
        })),
      };
    } catch (error) {
      getLogger("nlquery").note("error", "[OpenKB] Failed to get suggestions:", { err: error });
      return { suggestions: [] }; // Gracefully return empty suggestions
    }
  });

/**
 * Get recent queries for role discovery/browsing
 */
export const getRecentQueriesFromOpenKB = createServerFn({
  method: "GET",
})
  .inputValidator((data: { limit?: number }) => data)
  .handler(
    async ({
      data: input,
    }): Promise<
      Array<{
        nlQuestion: string;
        generatedSQL: string;
        executionTimeMs: number;
        resultRowCount: number;
      }>
    > => {
      const session = await requireAuth();

      try {
        const openkb = await getOpenKBClient();
        const roleId = session.user.roles[0] ?? "default";

        const recent = await openkb.getRecentQueries(roleId, input.limit || 20);

        return recent.map((q) => ({
          nlQuestion: q.nlQuestion,
          generatedSQL: q.generatedSQL,
          executionTimeMs: q.executionTimeMs,
          resultRowCount: q.resultRowCount,
        }));
      } catch (error) {
        getLogger("nlquery").note("error", "[OpenKB] Failed to get recent queries:", { err: error });
        return [];
      }
    }
  );

/**
 * Get OpenKB statistics for a role (admin/monitoring)
 */
export const getOpenKBStats = createServerFn({
  method: "GET",
}).handler(
  async (): Promise<{
    queryCount: number;
    oldestQuery?: Date;
    newestQuery?: Date;
  }> => {
    const session = await requireAuth();

    try {
      const openkb = await getOpenKBClient();
      const roleId = session.user.roles[0] ?? "default";

      const stats = await openkb.getStats(roleId);

      return {
        queryCount: stats.queryCount,
        oldestQuery: stats.oldestQuery ? new Date(stats.oldestQuery) : undefined,
        newestQuery: stats.newestQuery ? new Date(stats.newestQuery) : undefined,
      };
    } catch (error) {
      getLogger("nlquery").note("error", "[OpenKB] Failed to get stats:", { err: error });
      return { queryCount: 0 };
    }
  }
);
