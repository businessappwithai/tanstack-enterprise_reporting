import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { findSimilarQueries, findRelevantSchema } from "@/lib/mastra/rag-store";
import type { DataSource } from "@/types/database";
import type { RelevantSchema, SimilarQuery } from "@/lib/mastra/rag-store";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

// Context budget tiers adapt to model capabilities
const BUDGET_TIERS = {
  small: { maxChars: 1500, maxQueries: 2, maxTables: 2, sampleRows: 0 },
  medium: { maxChars: 4000, maxQueries: 3, maxTables: 3, sampleRows: 1 },
  large: { maxChars: 8000, maxQueries: 3, maxTables: 5, sampleRows: 2 },
} as const;

type BudgetTier = keyof typeof BUDGET_TIERS;

function selectTier(contextBudget?: number): BudgetTier {
  if (!contextBudget) return "medium";
  if (contextBudget <= 2000) return "small";
  if (contextBudget <= 5000) return "medium";
  return "large";
}

function buildModularContext(
  similarQueries: SimilarQuery[],
  relevantSchema: RelevantSchema[],
  tier: BudgetTier
): {
  contextText: string;
  modules: { name: string; status: string; detail?: string; chars: number }[];
} {
  const budget = BUDGET_TIERS[tier];
  const modules: { name: string; status: string; detail?: string; chars: number }[] = [];
  const parts: string[] = [];
  let used = 0;

  // Module 1: Similar past queries (highest priority — proven SQL)
  const queries = similarQueries.slice(0, budget.maxQueries);
  if (queries.length > 0) {
    const qParts: string[] = ["PROVEN SQL FROM PAST QUERIES:"];
    for (const q of queries) {
      qParts.push(`Q: "${q.naturalLanguageQuery}" → SQL: ${q.generatedSql}`);
    }
    const qText = qParts.join("\n");
    if (used + qText.length <= budget.maxChars) {
      parts.push(qText);
      used += qText.length;
      modules.push({
        name: "Past queries",
        status: "done",
        detail: `${queries.length} proven SQL`,
        chars: qText.length,
      });
    } else {
      modules.push({
        name: "Past queries",
        status: "trimmed",
        detail: "Exceeded budget",
        chars: 0,
      });
    }
  } else {
    modules.push({ name: "Past queries", status: "done", detail: "None found yet", chars: 0 });
  }

  // Module 2: Relevant table schemas (critical for SQL generation)
  const tables = relevantSchema.slice(0, budget.maxTables);
  if (tables.length > 0) {
    const tParts: string[] = ["RELEVANT TABLES:"];
    for (const s of tables) {
      tParts.push(s.schemaText);
      if (budget.sampleRows > 0 && s.sampleData && s.sampleData.length > 0) {
        const sample = s.sampleData[0];
        const keys = Object.keys(sample);
        const vals = keys.map((k) => `${k}=${sample[k]}`).join(", ");
        tParts.push(`  Example: ${vals}`);
      }
    }
    const tText = tParts.join("\n");
    if (used + tText.length <= budget.maxChars) {
      parts.push(tText);
      used += tText.length;
      modules.push({
        name: "Schema context",
        status: "done",
        detail: `${tables.length} tables`,
        chars: tText.length,
      });
    } else {
      // Fit as many tables as possible
      const fitParts: string[] = ["RELEVANT TABLES:"];
      let fitCount = 0;
      for (const s of tables) {
        const candidate = `${fitParts.join("\n")}\n${s.schemaText}`;
        if (used + candidate.length > budget.maxChars) break;
        fitParts.push(s.schemaText);
        fitCount++;
      }
      if (fitCount > 0) {
        const fitText = fitParts.join("\n");
        parts.push(fitText);
        used += fitText.length;
        modules.push({
          name: "Schema context",
          status: "trimmed",
          detail: `${fitCount}/${tables.length} tables fit`,
          chars: fitText.length,
        });
      } else {
        modules.push({
          name: "Schema context",
          status: "trimmed",
          detail: "No room in budget",
          chars: 0,
        });
      }
    }
  } else {
    modules.push({ name: "Schema context", status: "done", detail: "No matches", chars: 0 });
  }

  modules.push({
    name: "Context budget",
    status: "done",
    detail: `${used}/${budget.maxChars} chars (${tier})`,
    chars: 0,
  });

  return { contextText: parts.join("\n\n"), modules };
}

async function keywordMatchTables(
  connection: any,
  dataSourceId: string,
  queryWords: string[],
  alreadyFound: Set<string>
): Promise<RelevantSchema[]> {
  try {
    const allSchema = await sql<{
      table_name: string;
      schema_text: string;
      sample_data: string | null;
    }>`
      SELECT table_name, schema_text, sample_data::text
      FROM nl_schema_embeddings
      WHERE data_source_id = ${dataSourceId}
        AND table_name LIKE 'bus_%'
    `.execute(connection);

    const matched: RelevantSchema[] = [];
    for (const row of allSchema.rows) {
      if (alreadyFound.has(row.table_name)) continue;
      const tableStem = row.table_name.replace("bus_", "").replace(/_/g, " ");
      const tableWords = tableStem.split(" ");
      const isMatch = queryWords.some((qw: string) =>
        tableWords.some((tw) => tw.startsWith(qw) || qw.startsWith(tw))
      );
      if (isMatch) {
        matched.push({
          tableName: row.table_name,
          schemaText: row.schema_text,
          sampleData: row.sample_data ? JSON.parse(row.sample_data) : null,
          similarity: 0.5,
        });
      }
    }
    return matched.slice(0, 5);
  } catch {
    return [];
  }
}

export const Route = createFileRoute("/api/nl-query/rag-context")({
  server: {
    handlers: {
      POST: withApiHandler("/api/nl-query/rag-context", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
          }

          const body = await request.json();
          const { query, data_source_id, context_budget, top_k_queries } = body;

          if (!query || !data_source_id) {
            return json(
              { success: false, error: { message: "query and data_source_id are required" } },
              { status: 400 }
            );
          }

          const tier = selectTier(context_budget);
          const maxQueries = top_k_queries ?? BUDGET_TIERS[tier].maxQueries;

          const db = getDb();
          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", data_source_id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              { success: false, error: { message: "Data source not found" } },
              { status: 404 }
            );
          }

          const connection = await getConnection(dataSource as unknown as DataSource);
          const budget = BUDGET_TIERS[tier];

          const [similarQueries, relevantSchema] = await Promise.all([
            findSimilarQueries(connection, data_source_id, query, maxQueries),
            findRelevantSchema(connection, data_source_id, query, budget.maxTables),
          ]);

          const queryWords = query
            .toLowerCase()
            .split(/\s+/)
            .filter((w: string) => w.length > 2);
          const alreadyFound = new Set(relevantSchema.map((s) => s.tableName));
          const keywordMatched = await keywordMatchTables(
            connection,
            data_source_id,
            queryWords,
            alreadyFound
          );

          const allRelevantSchema = [...relevantSchema, ...keywordMatched];
          const { contextText, modules } = buildModularContext(
            similarQueries,
            allRelevantSchema,
            tier
          );

          return json({
            success: true,
            data: {
              similarQueries,
              relevantSchema: allRelevantSchema,
              contextText,
              tier,
              modules,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch RAG context");
        }
      }),
    },
  },
});
