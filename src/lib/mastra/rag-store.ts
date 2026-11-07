/**
 * RAG Store: pgvector-backed similarity search for NL query caching
 *
 * Stores successful NL→SQL mappings and per-table schema context as vector
 * embeddings in the USER's database (e.g. hospital_management_system) using
 * pgvector.  Embeddings come from llama.cpp's /v1/embeddings endpoint
 * (a separate llama.cpp instance with --embeddings flag).  When no embedding
 * server is available, falls back to a deterministic hash-based embedding so
 * the pipeline still works, just with lower-quality similarity.
 */

import { sql } from "kysely";
import type { Kysely } from "kysely";
import { getConnection } from "@/lib/db/connection-manager";
import type { DataSource } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

const EMBEDDING_DIM = 384;
const EMBEDDING_BASE_URL =
  process.env.AI_EMBEDDING_BASE_URL ??
  `${process.env.LLAMA_EMBEDDING_URL ?? process.env.LLAMA_REASONING_URL ?? "http://localhost:8080"}/v1`;
const EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? process.env.LLAMA_EMBEDDING_MODEL ?? "embedding";

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

let _embeddingAvailable: boolean | null = null;

async function llamaEmbed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      _embeddingAvailable = false;
      return null;
    }
    const data = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    const vec = data.data?.[0]?.embedding;
    if (vec && vec.length > 0) {
      _embeddingAvailable = true;
      return vec;
    }
    return null;
  } catch {
    _embeddingAvailable = false;
    return null;
  }
}

function hashEmbed(text: string): number[] {
  const vec = new Float32Array(EMBEDDING_DIM);
  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/);
  const tokens = new Set<string>();
  for (const w of words) {
    tokens.add(w);
    for (let i = 0; i < w.length - 1; i++) tokens.add(w.substring(i, i + 2));
    for (let i = 0; i < w.length - 2; i++) tokens.add(w.substring(i, i + 3));
  }
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) {
      h = ((h << 5) - h + tok.charCodeAt(i)) | 0;
    }
    const idx = ((h % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM;
    vec[idx] += 0.2;
    vec[(idx + 1) % EMBEDDING_DIM] += 0.1;
    vec[(idx + 2) % EMBEDDING_DIM] += 0.05;
  }
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1;
  const out: number[] = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = vec[i] / mag;
  return out;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (_embeddingAvailable !== false) {
    const vec = await llamaEmbed(text);
    if (vec) return vec.length === EMBEDDING_DIM ? vec : padOrTruncate(vec, EMBEDDING_DIM);
  }
  return hashEmbed(text);
}

function padOrTruncate(vec: number[], dim: number): number[] {
  if (vec.length === dim) return vec;
  if (vec.length > dim) return vec.slice(0, dim);
  const out = new Array(dim).fill(0);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i];
  return out;
}

function queryHash(text: string): string {
  const n = text.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 0n;
  for (let i = 0; i < n.length; i++) h = (h * 31n + BigInt(n.charCodeAt(i))) & 0xffffffffffffffffn;
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// Similarity search — past queries
// ---------------------------------------------------------------------------

export interface SimilarQuery {
  naturalLanguageQuery: string;
  generatedSql: string;
  explanation: string | null;
  similarity: number;
}

export async function findSimilarQueries(
  connection: Kysely<any>,
  dataSourceId: string,
  queryText: string,
  limit = 5
): Promise<SimilarQuery[]> {
  const embedding = await generateEmbedding(queryText);
  const vecLiteral = `[${embedding.join(",")}]`;

  try {
    const result = await sql<{
      natural_language_query: string;
      generated_sql: string;
      explanation: string | null;
      similarity: number;
    }>`
      SELECT natural_language_query, generated_sql, explanation,
             1 - (embedding <=> ${sql.lit(vecLiteral)}::vector) AS similarity
      FROM nl_query_embeddings
      WHERE data_source_id = ${dataSourceId}
        AND success = true
      ORDER BY embedding <=> ${sql.lit(vecLiteral)}::vector
      LIMIT ${sql.lit(limit)}
    `.execute(connection);

    return result.rows
      .filter((r) => r.similarity > 0.3)
      .map((r) => ({
        naturalLanguageQuery: r.natural_language_query,
        generatedSql: r.generated_sql,
        explanation: r.explanation,
        similarity: r.similarity,
      }));
  } catch (e) {
    getLogger("nlquery").event("nlquery.rag.degraded", { what: "FindSimilarQueries failed", err: e });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Similarity search — schema context
// ---------------------------------------------------------------------------

export interface RelevantSchema {
  tableName: string;
  schemaText: string;
  sampleData: Record<string, unknown>[] | null;
  similarity: number;
}

export async function findRelevantSchema(
  connection: Kysely<any>,
  dataSourceId: string,
  queryText: string,
  limit = 10
): Promise<RelevantSchema[]> {
  const embedding = await generateEmbedding(queryText);
  const vecLiteral = `[${embedding.join(",")}]`;

  try {
    const result = await sql<{
      table_name: string;
      schema_text: string;
      sample_data: string | null;
      similarity: number;
    }>`
      SELECT table_name, schema_text, sample_data::text,
             1 - (embedding <=> ${sql.lit(vecLiteral)}::vector) AS similarity
      FROM nl_schema_embeddings
      WHERE data_source_id = ${dataSourceId}
      ORDER BY embedding <=> ${sql.lit(vecLiteral)}::vector
      LIMIT ${sql.lit(limit)}
    `.execute(connection);

    return result.rows
      .filter((r) => r.similarity > 0.2)
      .map((r) => ({
        tableName: r.table_name,
        schemaText: r.schema_text,
        sampleData: r.sample_data ? JSON.parse(r.sample_data) : null,
        similarity: r.similarity,
      }));
  } catch (e) {
    getLogger("nlquery").event("nlquery.rag.degraded", { what: "FindRelevantSchema failed", err: e });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store successful query
// ---------------------------------------------------------------------------

export async function storeQueryEmbedding(
  connection: Kysely<any>,
  dataSourceId: string,
  naturalLanguageQuery: string,
  generatedSql: string,
  explanation: string | null,
  rowCount: number | null,
  executionTimeMs: number | null
): Promise<void> {
  const hash = queryHash(naturalLanguageQuery);
  const embedding = await generateEmbedding(naturalLanguageQuery);
  const vecLiteral = `[${embedding.join(",")}]`;

  try {
    // Use query_hash + data_source_id for dedup — same question updates the stored SQL
    const existing = await sql<{ id: string }>`
      SELECT id FROM nl_query_embeddings
      WHERE data_source_id = ${dataSourceId} AND query_hash = ${hash}
      LIMIT 1
    `.execute(connection);

    if (existing.rows.length > 0) {
      await sql`
        UPDATE nl_query_embeddings
        SET generated_sql = ${generatedSql},
            embedding = ${sql.lit(vecLiteral)}::vector,
            row_count = ${rowCount},
            execution_time_ms = ${executionTimeMs},
            success = true
        WHERE id = ${existing.rows[0].id}
      `.execute(connection);
    } else {
      await sql`
        INSERT INTO nl_query_embeddings
          (data_source_id, natural_language_query, generated_sql, explanation,
           query_hash, embedding, row_count, execution_time_ms, success)
        VALUES
          (${dataSourceId}, ${naturalLanguageQuery}, ${generatedSql}, ${explanation},
           ${hash}, ${sql.lit(vecLiteral)}::vector, ${rowCount}, ${executionTimeMs}, true)
      `.execute(connection);
    }
  } catch (e) {
    getLogger("nlquery").event("nlquery.rag.degraded", { what: "StoreQueryEmbedding failed", err: e });
  }
}

// ---------------------------------------------------------------------------
// Store schema + sample data per table
// ---------------------------------------------------------------------------

export async function storeSchemaEmbeddings(
  connection: Kysely<any>,
  dataSourceId: string,
  tables: { name: string; columns: { column_name: string; data_type: string }[] }[],
  sampleData: Record<string, Record<string, unknown>[]>
): Promise<void> {
  for (const table of tables) {
    const colDefs = table.columns.map((c) => `${c.column_name} (${c.data_type})`).join(", ");
    const samples = sampleData[table.name] || [];
    const schemaText = `TABLE ${table.name}: ${colDefs}`;
    const contextText =
      samples.length > 0
        ? `${schemaText}\nSAMPLE DATA:\n${JSON.stringify(samples.slice(0, 5), null, 0)}`
        : schemaText;

    const embedding = await generateEmbedding(contextText);
    const vecLiteral = `[${embedding.join(",")}]`;
    const sampleJson = JSON.stringify(samples.slice(0, 5));

    try {
      await sql`
        INSERT INTO nl_schema_embeddings
          (data_source_id, table_name, schema_text, sample_data, embedding)
        VALUES
          (${dataSourceId}, ${table.name}, ${schemaText}, ${sampleJson}::jsonb,
           ${sql.lit(vecLiteral)}::vector)
        ON CONFLICT (data_source_id, table_name)
        DO UPDATE SET
          schema_text = EXCLUDED.schema_text,
          sample_data = EXCLUDED.sample_data,
          embedding = EXCLUDED.embedding,
          updated_at = NOW()
      `.execute(connection);
    } catch (e) {
      getLogger("nlquery").event("nlquery.rag.degraded", { what: `StoreSchemaEmbeddings failed for ${table.name}`, err: e });
    }
  }
}

// ---------------------------------------------------------------------------
// Build RAG context string for the LLM prompt
// ---------------------------------------------------------------------------

export async function buildRagContext(dataSource: DataSource, queryText: string): Promise<string> {
  try {
    const connection = await getConnection(dataSource);

    const [similarQueries, relevantSchema] = await Promise.all([
      findSimilarQueries(connection, dataSource.id, queryText, 3),
      findRelevantSchema(connection, dataSource.id, queryText, 8),
    ]);

    const parts: string[] = [];

    if (similarQueries.length > 0) {
      parts.push("SIMILAR SUCCESSFUL PAST QUERIES:");
      for (const q of similarQueries) {
        parts.push(`  Q: "${q.naturalLanguageQuery}"`);
        parts.push(`  SQL: ${q.generatedSql}`);
        if (q.explanation) parts.push(`  (${q.explanation})`);
        parts.push("");
      }
    }

    if (relevantSchema.length > 0) {
      parts.push("RELEVANT TABLE CONTEXT (with sample data):");
      for (const s of relevantSchema) {
        parts.push(`  ${s.schemaText}`);
        if (s.sampleData && s.sampleData.length > 0) {
          parts.push(`  Sample rows: ${JSON.stringify(s.sampleData.slice(0, 3))}`);
        }
        parts.push("");
      }
    }

    return parts.join("\n");
  } catch (e) {
    getLogger("nlquery").event("nlquery.rag.degraded", { what: "BuildRagContext failed", err: e });
    return "";
  }
}

// ---------------------------------------------------------------------------
// Introspect schema and store embeddings (called on schema refresh)
// ---------------------------------------------------------------------------

export async function introspectAndStoreSchemaEmbeddings(
  dataSource: DataSource
): Promise<{ tableCount: number; embeddingType: string }> {
  const connection = await getConnection(dataSource);

  const allColumnsResult = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      )
    ORDER BY table_name, ordinal_position
  `.execute(connection);

  const tableMap = new Map<string, { column_name: string; data_type: string }[]>();
  for (const row of allColumnsResult.rows) {
    if (!tableMap.has(row.table_name)) tableMap.set(row.table_name, []);
    tableMap.get(row.table_name)!.push({
      column_name: row.column_name,
      data_type: row.data_type,
    });
  }

  const sampleData: Record<string, Record<string, unknown>[]> = {};
  for (const tableName of tableMap.keys()) {
    try {
      const result = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.ref(tableName)} LIMIT 5
      `.execute(connection);
      sampleData[tableName] = result.rows as Record<string, unknown>[];
    } catch {
      sampleData[tableName] = [];
    }
  }

  const tables = Array.from(tableMap.entries()).map(([name, columns]) => ({
    name,
    columns,
  }));

  await storeSchemaEmbeddings(connection, dataSource.id, tables, sampleData);

  return {
    tableCount: tables.length,
    embeddingType: _embeddingAvailable ? "llama.cpp" : "hash-fallback",
  };
}
