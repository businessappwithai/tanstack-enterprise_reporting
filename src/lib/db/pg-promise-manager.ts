import pgPromise from "pg-promise";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { DataSource } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

// dynamic database schema
type AnyKysely = Kysely<any>;

interface PgConnectionConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

/**
 * pg-promise initialization with battle-tested SSL configuration
 * Handles complex SSL/TLS scenarios like Neon's SASL channel binding
 */
const pgp = pgPromise({
  // Enable detailed error logging
  error(err, e) {
    getLogger("datasource").event("datasource.connection.failed", { what: "", detail: [{
      message: err.message,
      code: (err as any).code,
      query: e?.query,
    }] });
  },

  // Runs for each new connection
  connect(e) {
    // Set connection timeout for queries
    void e.client.query("SET idle_in_transaction_session_timeout = 60000");
  },
});

/**
 * Create a PostgreSQL connection using pg-promise with proper SSL handling
 * This is battle-tested and handles Neon's strict SSL/SASL requirements
 */
export async function createPgPromiseConnection(config: PgConnectionConfig): Promise<AnyKysely> {
  try {
    // Build connection config with SSL settings
    const connectionConfig: any = {
      // Connection pool configuration for pg
      max: 10,
      min: 0,
      idleTimeoutMillis: 600000,
      connectionTimeoutMillis: 60000,
      statement_timeout: 60000,
      keepalives: 1,
      keepalives_idle: 30,

      // SSL configuration for external databases like Neon
      ssl: {
        rejectUnauthorized: false, // Allow self-signed certs
        minVersion: "TLSv1.2", // Require modern TLS
      },
    };

    // Use connection string if provided (Neon uses this)
    if (config.connectionString) {
      connectionConfig.connectionString = config.connectionString;
    } else {
      // Otherwise build from individual components
      connectionConfig.host = config.host;
      connectionConfig.port = config.port || 5432;
      connectionConfig.database = config.database;
      connectionConfig.user = config.user;
      connectionConfig.password = config.password;
    }

    // Create database instance with pg directly (not pg-promise)
    const pool = new (require("pg").Pool)(connectionConfig);

    // Test connection before returning
    const result = await pool.query("SELECT 1");
    if (!result) {
      throw new Error("Connection test failed");
    }

    // Wrap pg pool in Kysely for consistency with existing code
    return new Kysely({
      dialect: new PostgresDialect({ pool }),
    });
  } catch (error) {
    getLogger("datasource").event("datasource.connection.failed", { what: "Failed to create connection", err: error });
    throw error;
  }
}

/**
 * Test a PostgreSQL connection with proper SSL handling
 * Returns detailed error information for debugging
 */
export async function testPgPromiseConnection(config: PgConnectionConfig): Promise<{
  success: boolean;
  message: string;
  latency?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const connectionConfig: any = {
      connectionTimeoutMillis: 30000,
      statement_timeout: 30000,
      ssl: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
    };

    if (config.connectionString) {
      connectionConfig.connectionString = config.connectionString;
    } else {
      connectionConfig.host = config.host;
      connectionConfig.port = config.port || 5432;
      connectionConfig.database = config.database;
      connectionConfig.user = config.user;
      connectionConfig.password = config.password;
    }

    // Create a one-time connection using pg-promise
    const db = pgp(connectionConfig);

    // Test the connection
    const result = await db.one("SELECT NOW() as now, version() as version");

    const latency = Date.now() - startTime;

    return {
      success: true,
      message: `Connection successful (${latency}ms). PostgreSQL ${result.version.split(",")[0]}`,
      latency,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latency = Date.now() - startTime;

    // Provide helpful error messages
    let friendlyMessage = message;
    if (message.includes("ETIMEDOUT") || message.includes("timeout")) {
      friendlyMessage = `Connection timeout after ${latency}ms. The database server may be unreachable or the network is blocking the connection.`;
    } else if (message.includes("ECONNREFUSED")) {
      friendlyMessage = `Connection refused. Check that the host and port are correct.`;
    } else if (message.includes("authentication failed")) {
      friendlyMessage = `Authentication failed. Check your username and password.`;
    }

    return {
      success: false,
      message: friendlyMessage,
      error: message,
    };
  }
}

// Clean up on exit
process.on("exit", () => {
  pgp.end();
});
