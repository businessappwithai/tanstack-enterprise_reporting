/**
 * Knowledge graph sync service.
 *
 * Reads live schema from each configured DataSource (via connection-manager +
 * schema-introspection) and config metadata from MariaDB (reports, charts,
 * dashboards), then upserts everything into the Apache AGE property graph.
 *
 * Idempotent — uses MERGE so it's safe to call on every boot or on demand.
 */

import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { introspectSchema } from "@/lib/sql/schema-introspection";
import { cypher, cypherWrite } from "./client";
import { getLogger } from "@/lib/logging/logger";

// --------------------------------------------------------------------------
// DataSource nodes
// --------------------------------------------------------------------------

async function syncDataSource(ds: {
  id: string;
  name: string;
  client_type: string;
  description: string | null;
}): Promise<void> {
  await cypherWrite(
    `MERGE (n:DataSource {id: $id})
     SET n.name = $name,
         n.client_type = $client_type,
         n.description = $description`,
    {
      id: ds.id,
      name: ds.name,
      client_type: ds.client_type,
      description: ds.description ?? "",
    }
  );
}

// --------------------------------------------------------------------------
// Table + Column nodes + FK edges
// --------------------------------------------------------------------------

async function syncSchemaForDataSource(
  ds: Parameters<typeof getConnection>[0],
  clientType: string
): Promise<void> {
  let connection: Awaited<ReturnType<typeof getConnection>>;
  try {
    connection = await getConnection(ds);
  } catch {
    return; // data source unreachable — skip silently
  }

  let schemaInfo: Awaited<ReturnType<typeof introspectSchema>>;
  try {
    schemaInfo = await introspectSchema(connection, clientType);
  } catch (err) {
    getLogger("graph").event("graph.sync.degraded", { what: `Schema introspection failed for ${ds.id}`, detail: [err instanceof Error ? err.message : err] });
    return;
  }

  for (const table of schemaInfo.schema.tables) {
    const tableFqn = `${ds.id}.${table.name}`;

    // Upsert Table node
    await cypherWrite(
      `MERGE (t:Table {fqn: $fqn})
       SET t.ds_id = $ds_id,
           t.name = $name,
           t.schema_name = $schema_name`,
      {
        fqn: tableFqn,
        ds_id: ds.id,
        name: table.name,
        schema_name: table.schema ?? "public",
      }
    );

    // Link DataSource → Table
    await cypherWrite(
      `MATCH (ds:DataSource {id: $ds_id}), (t:Table {fqn: $fqn})
       MERGE (ds)-[:HAS_TABLE]->(t)`,
      { ds_id: ds.id, fqn: tableFqn }
    );

    // Upsert Column nodes
    for (const col of table.columns) {
      const colFqn = `${tableFqn}.${col.name}`;
      await cypherWrite(
        `MERGE (c:Column {fqn: $fqn})
         SET c.ds_id = $ds_id,
             c.table_name = $table_name,
             c.name = $name,
             c.data_type = $data_type,
             c.nullable = $nullable,
             c.is_pk = $is_pk`,
        {
          fqn: colFqn,
          ds_id: ds.id,
          table_name: table.name,
          name: col.name,
          data_type: col.type,
          nullable: col.nullable,
          is_pk: col.isPrimaryKey ?? false,
        }
      );

      // Link Table → Column
      await cypherWrite(
        `MATCH (t:Table {fqn: $table_fqn}), (c:Column {fqn: $col_fqn})
         MERGE (t)-[:HAS_COLUMN]->(c)`,
        { table_fqn: tableFqn, col_fqn: colFqn }
      );
    }

    // FK relationships
    for (const fk of table.foreignKeys ?? []) {
      const fromColFqn = `${tableFqn}.${fk.column}`;
      const toColFqn = `${ds.id}.${fk.referencedTable}.${fk.referencedColumn}`;
      await cypherWrite(
        `MATCH (a:Column {fqn: $from}), (b:Column {fqn: $to})
         MERGE (a)-[:FK_REFERENCES]->(b)`,
        { from: fromColFqn, to: toColFqn }
      );
    }
  }
}

// --------------------------------------------------------------------------
// Report / Chart / Dashboard nodes
// --------------------------------------------------------------------------

async function syncReports(): Promise<void> {
  const db = getDb();
  const reports = await db
    .selectFrom("report_definitions")
    .leftJoin("saved_queries", "saved_queries.id", "report_definitions.saved_query_id")
    .select([
      "report_definitions.id",
      "report_definitions.name",
      "report_definitions.description",
      "saved_queries.data_source_id",
    ])
    .where("report_definitions.is_deleted", "=", false)
    .execute();

  for (const r of reports) {
    await cypherWrite(
      `MERGE (n:Report {id: $id})
       SET n.name = $name, n.description = $description, n.ds_id = $ds_id`,
      { id: r.id, name: r.name, description: r.description ?? "", ds_id: r.data_source_id ?? "" }
    );
    if (r.data_source_id) {
      await cypherWrite(
        `MATCH (ds:DataSource {id: $ds_id}), (r:Report {id: $id})
         MERGE (r)-[:BUILT_ON]->(ds)`,
        { ds_id: r.data_source_id, id: r.id }
      );
    }
  }
}

async function syncCharts(): Promise<void> {
  const db = getDb();
  const charts = await db
    .selectFrom("chart_definitions")
    .leftJoin("saved_queries", "saved_queries.id", "chart_definitions.saved_query_id")
    .select([
      "chart_definitions.id",
      "chart_definitions.name",
      "chart_definitions.description",
      "chart_definitions.chart_type",
      "saved_queries.data_source_id",
    ])
    .where("chart_definitions.is_deleted", "=", false)
    .execute();

  for (const c of charts) {
    await cypherWrite(
      `MERGE (n:Chart {id: $id})
       SET n.name = $name, n.description = $description, n.chart_type = $chart_type, n.ds_id = $ds_id`,
      {
        id: c.id,
        name: c.name,
        description: c.description ?? "",
        chart_type: c.chart_type,
        ds_id: c.data_source_id ?? "",
      }
    );
    if (c.data_source_id) {
      await cypherWrite(
        `MATCH (ds:DataSource {id: $ds_id}), (ch:Chart {id: $id})
         MERGE (ch)-[:BUILT_ON]->(ds)`,
        { ds_id: c.data_source_id, id: c.id }
      );
    }
  }
}

async function syncDashboards(): Promise<void> {
  const db = getDb();
  const dashboards = await db
    .selectFrom("dashboard_layouts")
    .select(["id", "name", "description"])
    .where("is_deleted", "=", false)
    .execute();

  for (const d of dashboards) {
    await cypherWrite(
      `MERGE (n:Dashboard {id: $id})
       SET n.name = $name, n.description = $description`,
      { id: d.id, name: d.name, description: d.description ?? "" }
    );
  }
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

export async function syncKnowledgeGraph(): Promise<void> {
  getLogger("graph").event("graph.sync.trace", { what: "Starting knowledge graph sync…" });
  const db = getDb();

  const dataSources = await db
    .selectFrom("data_sources")
    .selectAll()
    .where("is_active", "=", true)
    .where("is_deleted", "=", false)
    .execute();

  for (const ds of dataSources) {
    await syncDataSource(ds);
    await syncSchemaForDataSource(ds, ds.client_type);
  }

  await syncReports();
  await syncCharts();
  await syncDashboards();

  getLogger("graph").event("graph.sync.trace", { what: `Done — synced ${dataSources.length} data source(s).` });
}
