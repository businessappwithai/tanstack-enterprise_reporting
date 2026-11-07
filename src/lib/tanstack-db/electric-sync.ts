/**
 * ElectricSQL Sync Adapter for TanStack DB
 * Provides real-time synchronization between local collections and server via ElectricSQL
 */

import type { ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";
import { getLogger } from "@/lib/logging/logger";

/**
 * Configuration for ElectricSQL sync
 */
export interface ElectricSyncConfig {
  collectionName: string;
  tableName: string;
  primaryKey: string;
  conflictResolution?: "last-write-wins" | "custom";
}

/**
 * Creates a sync function for TanStack DB that uses ElectricSQL
 * Provides real-time synchronization with server state
 */
export function createElectricSyncAdapter(config: ElectricSyncConfig) {
  const { collectionName, tableName, primaryKey } = config;

  // Return a sync configuration that TanStack DB will use
  // TanStack DB expects the sync adapter to be a callable function
  const syncAdapter = (params: {
    collection: any;
    begin: (options?: { immediate?: boolean }) => void;
    write: (message: ChangeMessageOrDeleteKeyMessage<any, any>) => void;
    commit: () => void;
    markReady: () => void;
    truncate: () => void;
    metadata?: any;
    [key: string]: any;
  }) => {
    const { begin, write, commit, markReady } = params;

    try {
      // Initialize sync
      begin();

      // In a production implementation:
      // 1. Load initial data from ElectricSQL
      // 2. Subscribe to real-time changes
      // 3. Set up bidirectional sync

      // For now, just mark as ready with local state
      markReady();
      commit();

      // Return cleanup function
      return () => {
        // Cleanup: unsubscribe, flush changes, close connections
      };
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: `Failed to initialize ElectricSQL sync for ${collectionName}`, err: error });
      // Mark ready even on error to unblock the UI
      markReady();
      return () => {};
    }
  };

  // TanStack DB expects config.sync to be an object with a `sync` method.
  // Spread as: ...createElectricSyncAdapter() -> { sync: { sync: syncAdapter } }
  return { sync: { sync: syncAdapter } };
}

/**
 * Helper to convert ElectricSQL changes to TanStack DB format
 */
export function convertElectricChangeToTanStackDB(
  change: any,
  primaryKey: string
): ChangeMessageOrDeleteKeyMessage<any, any> {
  const { type, record } = change;

  switch (type) {
    case "insert":
    case "update":
      return {
        type: "insert",
        value: record,
      };
    case "delete":
      return {
        type: "delete",
        key: record[primaryKey],
      };
    default:
      throw new Error(`Unknown change type: ${type}`);
  }
}

/**
 * Configure ElectricSQL for a TanStack DB collection
 * Call this during app initialization
 */
export async function configureElectricSQL(options: {
  dbUrl?: string;
  authToken?: string;
  replicationUrl?: string;
}): Promise<void> {
  // ElectricSQL configuration would happen here:
  // 1. Initialize local SQLite for client-side collections
  // 2. Connect to ElectricSQL sync server
  // 3. Configure replication rules
  // 4. Start background sync process

  // For now, this is a placeholder
}

/**
 * Get ElectricSQL sync config for a collection
 * Standardizes sync configuration across all collections
 */
export function getElectricSyncConfig(
  collectionId: string,
  tableName: string,
  primaryKey: string = "id"
): ElectricSyncConfig {
  return {
    collectionName: collectionId,
    tableName,
    primaryKey,
    conflictResolution: "last-write-wins",
  };
}
