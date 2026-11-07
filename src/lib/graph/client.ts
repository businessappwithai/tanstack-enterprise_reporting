/**
 * Apache AGE client — thin wrapper around `pg` for Cypher graph queries.
 *
 * AGE is a PostgreSQL extension; queries go over the same `pg` Pool that
 * other PostgreSQL work uses.  Two steps are needed per connection:
 *   LOAD 'age'
 *   SET search_path = ag_catalog, "$user", public
 *
 * Always use fully-qualified ag_catalog.cypher() and ag_catalog.agtype so
 * the function resolves correctly regardless of search_path ordering.
 * Params are cast to ag_catalog.agtype (not jsonb) per the AGE 1.5 API.
 */

import { Pool, type PoolClient } from "pg";
import { getLogger } from "@/lib/logging/logger";

const GRAPH_DATABASE_URL =
  process.env.GRAPH_DATABASE_URL ?? "postgresql://graph:graphpass@localhost:5433/ers_knowledge";

export const GRAPH_NAME = "knowledge_graph";

let _pool: Pool | null = null;

async function setupClient(client: PoolClient): Promise<void> {
  await client.query(`LOAD 'age'`);
  await client.query(`SET search_path = ag_catalog, "$user", public`);
}

function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: GRAPH_DATABASE_URL, max: 10 });
  // As the config pool (kysely-db.ts): without a listener, a dropped idle connection
  // is an unhandled `error` event and exits the process.
  _pool.on("error", (err: Error) => {
    getLogger("db").event("db.pool.error", { pool: "knowledge graph", err });
  });
  _pool.on("connect", (client) => {
    setupClient(client).catch(() => {});
  });
  return _pool;
}

export interface CypherRow {
  [alias: string]: unknown;
}

/**
 * Run a Cypher query against `knowledge_graph`.
 *
 * @param cql     - Cypher string; use $paramName syntax for variables.
 * @param params  - Variables injected into the Cypher as a JSON object.
 * @param aliases - Column aliases declared in the AS (...) clause.
 */
export async function cypher(
  cql: string,
  params: Record<string, unknown> = {},
  aliases: string[] = []
): Promise<CypherRow[]> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    await setupClient(client);

    const asCols =
      aliases.length > 0
        ? aliases.map((a) => `${a} ag_catalog.agtype`).join(", ")
        : "result ag_catalog.agtype";

    const hasParams = Object.keys(params).length > 0;
    let sql: string;
    let queryParams: unknown[];

    if (hasParams) {
      // Third arg must be a $N placeholder cast to ag_catalog.agtype
      sql = `SELECT * FROM ag_catalog.cypher('${GRAPH_NAME}', $$ ${cql} $$, $1::ag_catalog.agtype) AS (${asCols})`;
      queryParams = [JSON.stringify(params)];
    } else {
      // Omit third arg entirely when no params — avoids the type-resolution issue
      sql = `SELECT * FROM ag_catalog.cypher('${GRAPH_NAME}', $$ ${cql} $$) AS (${asCols})`;
      queryParams = [];
    }

    const result = await client.query(sql, queryParams);
    return result.rows as CypherRow[];
  } finally {
    client.release();
  }
}

/**
 * Run a Cypher query that returns no rows (CREATE / MERGE / DELETE).
 * Parameters are inlined into the Cypher string to avoid type-resolution issues.
 */
export async function cypherWrite(
  cql: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    await setupClient(client);

    // Inline parameters into the Cypher string (safe: we own all param values)
    let inlinedCql = cql;
    for (const [key, val] of Object.entries(params)) {
      const jsonVal =
        typeof val === "string"
          ? `'${val.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
          : val === null || val === undefined
            ? "null"
            : typeof val === "boolean"
              ? String(val)
              : typeof val === "number"
                ? String(val)
                : `'${String(val).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
      inlinedCql = inlinedCql.replace(new RegExp(`\\$${key}\\b`, "g"), jsonVal);
    }

    const sql = `SELECT * FROM ag_catalog.cypher('${GRAPH_NAME}', $$ ${inlinedCql} $$) AS (result ag_catalog.agtype)`;
    await client.query(sql);
  } finally {
    client.release();
  }
}

/**
 * Run raw PostgreSQL SQL against the graph database (for extension setup,
 * graph creation, and DDL that isn't expressible in Cypher).
 */
export async function graphSql(
  sql: string,
  values: unknown[] = []
): Promise<import("pg").QueryResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await setupClient(client);
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}
