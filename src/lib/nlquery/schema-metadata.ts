/**
 * Database Schema Metadata Extraction
 *
 * Fetches and caches table/column information from datasources
 * for use in NL→SQL generation and validation.
 */

import { getConnection } from "@/lib/db/connection-manager";
import type { SchemaMetadata } from "@/lib/validation/translation-validator";
import type { DataSource } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

interface TableMetadata {
  name: string;
  type: "table" | "view";
  columns?: string[];
}

/**
 * Fetch database schema from a datasource
 *
 * Returns tables, views, and their columns for use in NL→SQL generation.
 * Caches results in memory to avoid repeated queries.
 */
const schemaCache = new Map<string, SchemaMetadata>();

export async function getSchemaMetadata(dataSource: DataSource): Promise<SchemaMetadata> {
  // Check cache first
  const cacheKey = dataSource.id;
  if (schemaCache.has(cacheKey)) {
    return schemaCache.get(cacheKey) as SchemaMetadata;
  }

  try {
    const connection = await getConnection(dataSource);
    const schema = await fetchDatabaseSchema(connection, dataSource.client_type);

    // Cache for 1 hour
    schemaCache.set(cacheKey, schema);
    setTimeout(() => schemaCache.delete(cacheKey), 3600000);

    return schema;
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "Failed to fetch schema", err: error });
    // Return empty schema on error
    return { tables: [] };
  }
}

/**
 * Fetch schema from database connection
 *
 * Supports PostgreSQL and SQLite.
 */
async function fetchDatabaseSchema(connection: any, clientType: string): Promise<SchemaMetadata> {
  const tables: TableMetadata[] = [];

  try {
    if (clientType === "pg" || clientType === "postgres") {
      tables.push(...(await fetchPostgresSchema(connection)));
    } else if (clientType === "sqlite3" || clientType === "sqlite") {
      tables.push(...(await fetchSqliteSchema(connection)));
    } else {
      getLogger("nlquery").event("nlquery.translate.degraded", { what: `Unsupported client type: ${clientType}` });
      return { tables: [] };
    }

    return {
      tables: tables.map((t) => ({
        name: t.name,
        columns: (t.columns ?? []).map((name) => ({ name, type: "unknown" })),
      })),
    };
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "Error fetching schema", err: error });
    return { tables: [] };
  }
}

/**
 * Fetch PostgreSQL schema (tables and columns)
 */
async function fetchPostgresSchema(connection: any): Promise<TableMetadata[]> {
  const query = `
    SELECT
      t.table_name,
      CASE WHEN t.table_type = 'VIEW' THEN 'view' ELSE 'table' END as table_type,
      ARRAY_AGG(c.column_name ORDER BY c.ordinal_position) as columns
    FROM information_schema.tables t
    LEFT JOIN information_schema.columns c ON t.table_catalog = c.table_catalog
      AND t.table_schema = c.table_schema
      AND t.table_name = c.table_name
    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
    GROUP BY t.table_name, t.table_type
    ORDER BY t.table_name;
  `;

  try {
    const result = await connection.raw(query);
    const rows = Array.isArray(result) ? result : result?.rows || [];

    return rows.map((row: any) => ({
      name: row.table_name,
      type: row.table_type || "table",
      columns: row.columns || [],
    }));
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "PostgreSQL schema fetch failed", err: error });
    return [];
  }
}

/**
 * Fetch SQLite schema (tables and columns)
 */
async function fetchSqliteSchema(connection: any): Promise<TableMetadata[]> {
  const tables: TableMetadata[] = [];

  try {
    // Get all tables
    const tablesQuery = `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `;
    const tablesResult = await connection.raw(tablesQuery);
    const tableRows = Array.isArray(tablesResult) ? tablesResult : tablesResult?.rows || [];

    for (const tableRow of tableRows) {
      const tableName = tableRow.name;

      // Get columns for this table
      const columnsQuery = `PRAGMA table_info(${tableName});`;
      try {
        const columnsResult = await connection.raw(columnsQuery);
        const columnRows = Array.isArray(columnsResult) ? columnsResult : columnsResult?.rows || [];
        const columns = columnRows.map((col: any) => col.name);

        tables.push({
          name: tableName,
          type: "table",
          columns,
        });
      } catch (error) {
        getLogger("nlquery").event("nlquery.translate.degraded", { what: `Failed to get columns for table ${tableName}`, err: error });
      }
    }

    return tables;
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "SQLite schema fetch failed", err: error });
    return [];
  }
}

/**
 * Clear schema cache (useful for tests or manual refresh)
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
}
