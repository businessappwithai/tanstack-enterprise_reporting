/* eslint-disable @typescript-eslint/no-unused-vars */
import { type Kysely, sql as kyselySql } from "kysely";
import type {
  ColumnSchema,
  ForeignKeyInfo,
  IndexInfo,
  SchemaInfo,
  TableInfo,
  ViewInfo,
} from "@/types/api";
import { getLogger } from "@/lib/logging/logger";

// external data source connections have unknown schema
type AnyKysely = Kysely<any>;

interface IntrospectionResult {
  schema: SchemaInfo;
  logs: string[];
}

export async function introspectSchema(
  connection: AnyKysely,
  dialect: string
): Promise<IntrospectionResult> {
  const logs: string[] = [];

  const addLog = (message: string) => {
    logs.push(`[${new Date().toISOString()}] ${message}`);
    getLogger("sql").note("debug", String(message));
  };

  const result = await introspectSchemaInternal(connection, dialect, addLog);

  return {
    schema: result,
    logs,
  };
}

async function introspectSchemaInternal(
  connection: AnyKysely,
  dialect: string,
  addLog: (msg: string) => void
): Promise<SchemaInfo> {
  switch (dialect) {
    case "pg":
    case "sqlite3":
      // sqlite3 connections use PGlite (PostgreSQL-compatible), so introspect as Postgres
      return introspectPostgres(connection, addLog);
    case "mysql":
      return introspectMySQL(connection, addLog);
    case "mssql":
      return introspectMSSQL(connection, addLog);
    default:
      return introspectGeneric(connection, addLog);
  }
}

async function introspectPostgres(
  connection: AnyKysely,
  _addLog: (msg: string) => void
): Promise<SchemaInfo> {
  const { rows: tables } = await kyselySql
    .raw(`
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
    .execute(connection);

  const { rows: views } = await kyselySql
    .raw(`
    SELECT table_name, table_schema, view_definition
    FROM information_schema.views
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    ORDER BY table_name
  `)
    .execute(connection);

  const tableInfos: TableInfo[] = await Promise.all(
    (tables as Array<{ table_name: string; table_schema: string }>).map(async (t) => {
      const columns = await getPostgresColumns(connection, t.table_schema, t.table_name);
      const primaryKey = await getPostgresPrimaryKey(connection, t.table_schema, t.table_name);
      const foreignKeys = await getPostgresForeignKeys(connection, t.table_schema, t.table_name);
      const indexes = await getPostgresIndexes(connection, t.table_schema, t.table_name);

      return {
        name: t.table_name,
        schema: t.table_schema,
        columns,
        primaryKey,
        foreignKeys,
        indexes,
      };
    })
  );

  const viewInfos: ViewInfo[] = await Promise.all(
    (views as Array<{ table_name: string; table_schema: string; view_definition: string }>).map(
      async (v) => {
        const columns = await getPostgresColumns(connection, v.table_schema, v.table_name);
        return {
          name: v.table_name,
          schema: v.table_schema,
          columns,
          definition: v.view_definition,
        };
      }
    )
  );

  return { tables: tableInfos, views: viewInfos };
}

async function getPostgresColumns(
  connection: AnyKysely,
  schema: string,
  table: string
): Promise<ColumnSchema[]> {
  const { rows } = await kyselySql`
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}
    ORDER BY ordinal_position
  `.execute(connection);

  return (
    rows as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }>
  ).map((c) => ({
    name: c.column_name,
    type: c.character_maximum_length
      ? `${c.data_type}(${c.character_maximum_length})`
      : c.data_type,
    nullable: c.is_nullable === "YES",
    defaultValue: c.column_default,
  }));
}

async function getPostgresPrimaryKey(
  connection: AnyKysely,
  schema: string,
  table: string
): Promise<string[]> {
  const { rows } = await kyselySql`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.indisprimary
    AND n.nspname = ${schema}
    AND c.relname = ${table}
  `.execute(connection);

  return (rows as Array<{ attname: string }>).map((r) => r.attname);
}

async function getPostgresForeignKeys(
  connection: AnyKysely,
  schema: string,
  table: string
): Promise<ForeignKeyInfo[]> {
  const { rows } = await kyselySql`
    SELECT
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = ${schema}
    AND tc.table_name = ${table}
  `.execute(connection);

  return (
    rows as Array<{ column_name: string; referenced_table: string; referenced_column: string }>
  ).map((r) => ({
    column: r.column_name,
    referencedTable: r.referenced_table,
    referencedColumn: r.referenced_column,
  }));
}

async function getPostgresIndexes(
  connection: AnyKysely,
  schema: string,
  table: string
): Promise<IndexInfo[]> {
  const { rows } = await kyselySql`
    SELECT
      i.relname as index_name,
      ix.indisunique as is_unique,
      array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = ${schema}
    AND t.relname = ${table}
    AND NOT ix.indisprimary
    GROUP BY i.relname, ix.indisunique
  `.execute(connection);

  return (rows as Array<{ index_name: string; is_unique: boolean; columns: string[] }>).map(
    (r) => ({
      name: r.index_name,
      columns: r.columns,
      unique: r.is_unique,
    })
  );
}

async function introspectMySQL(
  connection: AnyKysely,
  _addLog: (msg: string) => void
): Promise<SchemaInfo> {
  const { rows: tables } = await kyselySql
    .raw(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
    AND table_type = 'BASE TABLE'
  `)
    .execute(connection);

  const { rows: views } = await kyselySql
    .raw(`
    SELECT table_name, view_definition
    FROM information_schema.views
    WHERE table_schema = DATABASE()
  `)
    .execute(connection);

  const tableInfos: TableInfo[] = await Promise.all(
    (tables as Array<{ table_name: string }>).map(async (t) => {
      const columns = await getMySQLColumns(connection, t.table_name);
      return {
        name: t.table_name,
        columns,
      };
    })
  );

  const viewInfos: ViewInfo[] = (
    views as Array<{ table_name: string; view_definition: string }>
  ).map((v) => ({
    name: v.table_name,
    columns: [],
    definition: v.view_definition,
  }));

  return { tables: tableInfos, views: viewInfos };
}

async function getMySQLColumns(connection: AnyKysely, table: string): Promise<ColumnSchema[]> {
  const { rows } = await kyselySql`DESCRIBE ${kyselySql.raw(table)}`.execute(connection);
  return (
    rows as Array<{
      Field: string;
      Type: string;
      Null: string;
      Default: string | null;
      Key: string;
    }>
  ).map((c) => ({
    name: c.Field,
    type: c.Type,
    nullable: c.Null === "YES",
    defaultValue: c.Default,
    isPrimaryKey: c.Key === "PRI",
  }));
}

async function introspectSQLite(
  connection: AnyKysely,
  addLog: (msg: string) => void
): Promise<SchemaInfo> {
  addLog("Starting SQLite schema introspection");

  try {
    await kyselySql.raw("SELECT 1").execute(connection);
    addLog("Database connection test successful");
  } catch (error) {
    addLog(`SQLite connection test failed: ${error}`);
    return { tables: [], views: [] };
  }

  const { rows: tableRows } = await kyselySql
    .raw(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)
    .execute(connection);

  const { rows: viewRows } = await kyselySql
    .raw(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'view'
    ORDER BY name
  `)
    .execute(connection);

  const tableList = tableRows as Array<{ name: string }>;
  const viewList = viewRows as Array<{ name: string; sql: string }>;

  addLog(`Found ${tableList.length} tables, ${viewList.length} views`);

  const tableInfos: TableInfo[] = await Promise.all(
    tableList.map(async (t) => {
      addLog(`Processing table: ${t.name}`);
      const columns = await getSQLiteColumns(connection, t.name, addLog);
      return { name: t.name, columns };
    })
  );

  const viewInfos: ViewInfo[] = viewList.map((v) => ({
    name: v.name,
    columns: [],
    definition: v.sql,
  }));

  addLog(`Schema introspection complete: ${tableInfos.length} tables, ${viewInfos.length} views`);

  return { tables: tableInfos, views: viewInfos };
}

async function getSQLiteColumns(
  connection: AnyKysely,
  table: string,
  addLog: (msg: string) => void
): Promise<ColumnSchema[]> {
  addLog(`Fetching columns for table: ${table}`);

  const { rows } = await kyselySql`PRAGMA table_info(${kyselySql.raw(table)})`.execute(connection);

  addLog(`Found ${rows.length} columns for table: ${table}`);

  return (
    rows as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>
  ).map((c) => ({
    name: c.name,
    type: c.type || "ANY",
    nullable: c.notnull === 0,
    defaultValue: c.dflt_value,
    isPrimaryKey: c.pk === 1,
  }));
}

async function introspectMSSQL(
  connection: AnyKysely,
  _addLog: (msg: string) => void
): Promise<SchemaInfo> {
  const { rows: tables } = await kyselySql
    .raw(`
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
    .execute(connection);

  const { rows: views } = await kyselySql
    .raw(`
    SELECT table_name, table_schema, view_definition
    FROM information_schema.views
    ORDER BY table_name
  `)
    .execute(connection);

  const tableInfos: TableInfo[] = await Promise.all(
    (tables as Array<{ table_name: string; table_schema: string }>).map(async (t) => {
      const columns = await getMSSQLColumns(connection, t.table_schema, t.table_name);
      return {
        name: t.table_name,
        schema: t.table_schema,
        columns,
      };
    })
  );

  const viewInfos: ViewInfo[] = (
    views as Array<{
      table_name: string;
      table_schema: string;
      view_definition: string;
    }>
  ).map((v) => ({
    name: v.table_name,
    schema: v.table_schema,
    columns: [],
    definition: v.view_definition,
  }));

  return { tables: tableInfos, views: viewInfos };
}

async function getMSSQLColumns(
  connection: AnyKysely,
  schema: string,
  table: string
): Promise<ColumnSchema[]> {
  const { rows } = await kyselySql`
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}
    ORDER BY ordinal_position
  `.execute(connection);

  return (
    rows as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }>
  ).map((c) => ({
    name: c.column_name,
    type: c.character_maximum_length
      ? `${c.data_type}(${c.character_maximum_length})`
      : c.data_type,
    nullable: c.is_nullable === "YES",
    defaultValue: c.column_default,
  }));
}

async function introspectGeneric(
  _connection: AnyKysely,
  _addLog: (msg: string) => void
): Promise<SchemaInfo> {
  return { tables: [], views: [] };
}
