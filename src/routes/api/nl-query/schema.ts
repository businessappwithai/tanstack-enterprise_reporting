import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { storeSchemaEmbeddings } from "@/lib/mastra/rag-store";
import type { DataSource } from "@/types/database";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

async function fetchSchema(request: Request) {
  const session = await getSession(request);
  if (!session?.user) {
    return json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
  }

  const url = new URL(request.url);
  let dataSourceId = url.searchParams.get("data_source_id");

  if (!dataSourceId && request.method === "POST") {
    const body = await request.json();
    dataSourceId = body.data_source_id || body.dataSourceId;
  }

  if (!dataSourceId) {
    return json(
      { success: false, error: { message: "data_source_id is required" } },
      { status: 400 }
    );
  }

  const db = getDb();

  const dataSource = await db
    .selectFrom("data_sources")
    .selectAll()
    .where("id", "=", dataSourceId)
    .where("is_deleted", "=", false)
    .executeTakeFirst();

  if (!dataSource) {
    return json({ success: false, error: { message: "Data source not found" } }, { status: 404 });
  }

  const connection = await getConnection(dataSource as unknown as DataSource);

  const allColumnsResult = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    ordinal_position: number;
  }>`
    SELECT table_name, column_name, data_type, ordinal_position
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
    if (!tableMap.has(row.table_name)) {
      tableMap.set(row.table_name, []);
    }
    tableMap.get(row.table_name)!.push({
      column_name: row.column_name,
      data_type: row.data_type,
    });
  }

  // Fetch top 5 sample rows per table for RAG context
  const sampleData: Record<string, Record<string, unknown>[]> = {};
  for (const tableName of tableMap.keys()) {
    try {
      const sampleResult = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.ref(tableName)} LIMIT 5
      `.execute(connection);
      sampleData[tableName] = sampleResult.rows as Record<string, unknown>[];
    } catch {
      sampleData[tableName] = [];
    }
  }

  // Store schema + sample data embeddings in user's DB (pgvector) — fire & forget
  const tablesForEmbedding = Array.from(tableMap.entries()).map(([name, columns]) => ({
    name,
    columns,
  }));
  storeSchemaEmbeddings(connection, dataSourceId, tablesForEmbedding, sampleData).catch((e) =>
    getLogger("nlquery").event("nlquery.embedding.store_failed", { target: "schema", err: e })
  );

  const tablesList: { name: string; columns: string[] }[] = [];
  const busTableNames: string[] = [];

  for (const [tableName, columns] of tableMap) {
    if (tableName.startsWith("nl_")) continue;
    tablesList.push({ name: tableName, columns: columns.map((c) => c.column_name) });
    if (tableName.startsWith("bus_")) {
      busTableNames.push(tableName);
    }
  }

  const instructions = await (db as any)
    .selectFrom("schema_table_instructions")
    .where("data_source_id", "=", dataSourceId)
    .selectAll()
    .execute();

  // Use bus_ tables if present, otherwise fall back to all non-nl_ tables
  const displayTableNames =
    busTableNames.length > 0 ? busTableNames : tablesList.map((t) => t.name);

  const compactSchema = [
    "DATABASE SCHEMA (PostgreSQL):",
    `Available tables: ${displayTableNames.join(", ")}`,
    "",
    "TABLE COLUMNS:",
    ...tablesList
      .filter((t) => displayTableNames.includes(t.name))
      .map((t) => `  ${t.name}: ${t.columns.join(", ")}`),
    "",
    "IMPORTANT: Call fetchSimilarQueries FIRST to get detailed column schemas and sample data for relevant tables before generating SQL.",
  ];

  if (instructions && instructions.length > 0) {
    compactSchema.push("\nTABLE INSTRUCTIONS:");
    for (const inst of instructions) {
      compactSchema.push(`${inst.table_name}: ${inst.llm_instructions || inst.description}`);
    }
  }

  return json({
    success: true,
    data: {
      data_source_id: dataSourceId,
      data_source_name: dataSource.name,
      client_type: dataSource.client_type,
      tables: tablesList,
      schemaText: compactSchema.join("\n"),
    },
  });
}

export const Route = createFileRoute("/api/nl-query/schema")({
  server: {
    handlers: {
      GET: withApiHandler("/api/nl-query/schema", async ({ request }: { request: Request }) => {
        try {
          return await fetchSchema(request);
        } catch (error) {
          throw serverFailure(error, "Failed to fetch schema");
        }
      }),
      POST: withApiHandler("/api/nl-query/schema", async ({ request }: { request: Request }) => {
        try {
          return await fetchSchema(request);
        } catch (error) {
          throw serverFailure(error, "Failed to fetch schema");
        }
      }),
    },
  },
});
