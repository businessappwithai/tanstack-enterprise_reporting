/**
 * Bootstrap the Apache AGE knowledge graph.
 *
 * Run once at application startup (idempotent):
 *   1. Enable the AGE extension in the graph database.
 *   2. Create the `knowledge_graph` property graph if it doesn't exist.
 *
 * Usage:
 *   import { initGraph } from "@/lib/graph/graph-init";
 *   await initGraph();   // safe to call on every boot
 */

import { GRAPH_NAME, graphSql } from "./client";
import { getLogger } from "@/lib/logging/logger";

export async function initGraph(): Promise<void> {
  await graphSql(`CREATE EXTENSION IF NOT EXISTS age`);
  await graphSql(`LOAD 'age'`);
  await graphSql(`SET search_path = ag_catalog, "$user", public`);

  // create_graph() raises an error if the graph already exists; catch it
  try {
    await graphSql(`SELECT create_graph($1)`, [GRAPH_NAME]);
    getLogger("graph").event("graph.sync.trace", { what: `Created property graph: ${GRAPH_NAME}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) throw err;
  }

  getLogger("graph").event("graph.sync.trace", { what: `Knowledge graph ready: ${GRAPH_NAME}` });
}
