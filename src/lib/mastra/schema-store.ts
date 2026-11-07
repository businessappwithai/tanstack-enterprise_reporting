/**
 * Schema Store: Manages introspected schema metadata and sample data
 * for use as RAG context in the NL-to-SQL pipeline.
 * Stores schema information in the ds_schema_cache table.
 */

import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { introspectSchema } from "@/lib/sql/schema-introspection";
import type { SchemaInfo } from "@/types/api";
import type { DataSource, DsSchemaCache } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

interface SchemaContext {
  schemaInfo: SchemaInfo;
  sampleData: Record<string, Record<string, unknown>[]>;
  schemaText: string; // Human-readable schema description for LLM context
}

/**
 * Introspect and cache the schema for a data source.
 * Fetches schema metadata and sample rows for each table.
 */
export async function introspectAndCacheSchema(dataSource: DataSource): Promise<SchemaContext> {
  const connection = await getConnection(dataSource);
  const { schema: schemaInfo } = await introspectSchema(connection, dataSource.client_type);

  // Fetch sample data (up to 5 rows per table)
  const sampleData: Record<string, Record<string, unknown>[]> = {};

  for (const table of schemaInfo.tables) {
    try {
      const rows = await connection.selectFrom(table.name).selectAll().limit(5).execute();
      sampleData[table.name] = rows;
    } catch (error) {
      getLogger("nlquery").event("nlquery.pipeline.degraded", { what: `Failed to fetch sample data for table ${table.name}`, err: error });
      sampleData[table.name] = [];
    }
  }

  // Build human-readable schema text for LLM context
  const schemaText = buildSchemaText(schemaInfo, sampleData);

  // Cache in database
  const db = getDb();
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const schemaMetadata = JSON.stringify(schemaInfo);
  const sampleDataJson = JSON.stringify(sampleData);

  await (db as any)
    .insertInto("ds_schema_cache")
    .values({
      id: crypto.randomUUID(),
      data_source_id: dataSource.id,
      schema_metadata: schemaMetadata,
      sample_data: sampleDataJson,
      embedding_data: schemaText,
      last_introspected_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict(
      (oc: { column: (c: string) => { doUpdateSet: (v: Record<string, unknown>) => unknown } }) =>
        oc.column("data_source_id").doUpdateSet({
          schema_metadata: schemaMetadata,
          sample_data: sampleDataJson,
          embedding_data: schemaText,
          last_introspected_at: now,
          updated_at: now,
        })
    )
    .execute();

  return { schemaInfo, sampleData, schemaText };
}

/**
 * Get cached schema context for a data source.
 * If no cache exists, introspects and creates one.
 */
export async function getSchemaContext(dataSource: DataSource): Promise<SchemaContext> {
  const db = getDb();

  const cached = (await (db as any)
    .selectFrom("ds_schema_cache")
    .where("data_source_id", "=", dataSource.id)
    .selectAll()
    .executeTakeFirst()) as DsSchemaCache | undefined;

  if (cached) {
    const schemaInfo: SchemaInfo = JSON.parse(cached.schema_metadata);
    const sampleData = cached.sample_data ? JSON.parse(cached.sample_data) : {};
    const schemaText = cached.embedding_data || buildSchemaText(schemaInfo, sampleData);

    return { schemaInfo, sampleData, schemaText };
  }

  // No cache - introspect and create
  return introspectAndCacheSchema(dataSource);
}

/**
 * Build a detailed human-readable text description of the database schema,
 * suitable for inclusion as context in an LLM prompt.
 */
function buildSchemaText(
  schemaInfo: SchemaInfo,
  sampleData: Record<string, Record<string, unknown>[]>
): string {
  const parts: string[] = [];

  parts.push("=== DATABASE SCHEMA ===\n");

  // Tables
  for (const table of schemaInfo.tables) {
    parts.push(`TABLE: ${table.schema ? `${table.schema}.` : ""}${table.name}`);
    parts.push("Columns:");

    for (const col of table.columns) {
      const constraints: string[] = [];
      if (col.isPrimaryKey) constraints.push("PRIMARY KEY");
      if (!col.nullable) constraints.push("NOT NULL");
      if (col.defaultValue) constraints.push(`DEFAULT ${col.defaultValue}`);
      const constraintStr = constraints.length > 0 ? ` [${constraints.join(", ")}]` : "";
      parts.push(`  - ${col.name}: ${col.type}${constraintStr}`);
    }

    // Primary key info
    if (table.primaryKey && table.primaryKey.length > 0) {
      parts.push(`Primary Key: (${table.primaryKey.join(", ")})`);
    }

    // Foreign keys
    if (table.foreignKeys && table.foreignKeys.length > 0) {
      parts.push("Foreign Keys:");
      for (const fk of table.foreignKeys) {
        parts.push(`  - ${fk.column} -> ${fk.referencedTable}(${fk.referencedColumn})`);
      }
    }

    // Sample data
    const samples = sampleData[table.name];
    if (samples && samples.length > 0) {
      parts.push(`Sample Data (${samples.length} rows):`);
      for (const row of samples.slice(0, 3)) {
        const entries = Object.entries(row)
          .map(([k, v]) => {
            const val =
              v === null ? "NULL" : typeof v === "string" ? `'${v.substring(0, 50)}'` : String(v);
            return `${k}=${val}`;
          })
          .join(", ");
        parts.push(`  ${entries}`);
      }
    }

    parts.push("");
  }

  // Views
  if (schemaInfo.views && schemaInfo.views.length > 0) {
    parts.push("=== VIEWS ===\n");
    for (const view of schemaInfo.views) {
      parts.push(`VIEW: ${view.schema ? `${view.schema}.` : ""}${view.name}`);
      if (view.definition) {
        parts.push(`Definition: ${view.definition.substring(0, 500)}`);
      }
      if (view.columns && view.columns.length > 0) {
        parts.push("Columns:");
        for (const col of view.columns) {
          parts.push(`  - ${col.name}: ${col.type}`);
        }
      }
      parts.push("");
    }
  }

  // Relationship summary
  const relationships = extractRelationships(schemaInfo);
  if (relationships.length > 0) {
    parts.push("=== TABLE RELATIONSHIPS ===\n");
    for (const rel of relationships) {
      parts.push(`${rel.from}.${rel.fromColumn} -> ${rel.to}.${rel.toColumn}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

interface Relationship {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

function extractRelationships(schemaInfo: SchemaInfo): Relationship[] {
  const relationships: Relationship[] = [];

  for (const table of schemaInfo.tables) {
    if (table.foreignKeys) {
      for (const fk of table.foreignKeys) {
        relationships.push({
          from: table.name,
          fromColumn: fk.column,
          to: fk.referencedTable,
          toColumn: fk.referencedColumn,
        });
      }
    }
  }

  return relationships;
}

/**
 * Invalidate schema cache for a data source
 */
export async function invalidateSchemaCache(dataSourceId: string): Promise<void> {
  const db = getDb();
  await (db as any)
    .deleteFrom("ds_schema_cache")
    .where("data_source_id", "=", dataSourceId)
    .execute();
}

/**
 * Get the list of table/view names from the cached schema
 */
export async function getCachedEntityNames(dataSourceId: string): Promise<string[]> {
  const db = getDb();
  const cached = (await (db as any)
    .selectFrom("ds_schema_cache")
    .where("data_source_id", "=", dataSourceId)
    .selectAll()
    .executeTakeFirst()) as DsSchemaCache | undefined;

  if (!cached) return [];

  const schemaInfo: SchemaInfo = JSON.parse(cached.schema_metadata);
  const tableNames = schemaInfo.tables.map((t) => t.name);
  const viewNames = (schemaInfo.views || []).map((v) => v.name);
  return [...tableNames, ...viewNames];
}
