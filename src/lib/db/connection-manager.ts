import { Kysely, MssqlDialect, MysqlDialect, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { resolve4 } from "node:dns/promises";
import { getDb } from "@/lib/db/config";
import { decrypt } from "@/lib/security/encryption";
import type { DatabaseClientType, DataSource } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

/**
 * Resolve a hostname to its first IPv4 address.
 * Docker's DNS may return IPv6 first; the pg library connects to the first
 * address it gets, and the IPv6 path fails on Neon pooler endpoints.
 * Passing ssl.servername preserves SNI so Neon can route the connection.
 */
async function resolveIPv4(hostname: string): Promise<string | null> {
  try {
    const addrs = await resolve4(hostname);
    return addrs[0] ?? null;
  } catch {
    return null;
  }
}

// external DB schema is unknown at compile time
type AnyKysely = Kysely<any>;

interface ConnectionPool {
  [key: string]: AnyKysely;
}

const connectionPool: ConnectionPool = {};

interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filename?: string;
  connectionString?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Parse PostgreSQL connection string into individual config fields
 * Supports: postgresql://user:password@host:port/database?ssl=require
 */
function parsePostgresConnectionString(connStr: string): Partial<ConnectionConfig> {
  try {
    const url = new URL(connStr);
    const config: Partial<ConnectionConfig> = {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 5432,
      database: url.pathname.replace(/^\//, ""),
      user: url.username,
      password: url.password,
    };

    // Handle SSL parameter
    const sslParam = url.searchParams.get("ssl");
    if (sslParam) {
      config.ssl = sslParam === "require" || sslParam === "true";
    }

    return config;
  } catch (error) {
    throw new Error(`Invalid PostgreSQL connection string: ${(error as Error).message}`);
  }
}

async function buildKyselyConnection(
  clientType: DatabaseClientType,
  connectionConfig: ConnectionConfig
): Promise<AnyKysely> {
  const buildId = Math.random().toString(36).substring(7);

  switch (clientType) {
    case "sqlite3": {
      throw new Error(
        "SQLite data sources are no longer supported. Please use PostgreSQL, MySQL, or SQL Server instead."
      );
    }

    case "pg": {

      // Build pool config with battle-tested SSL/TLS settings for Neon and other external databases
      const poolConfig: any = {
        // Connection pool configuration
        max: 5, // Reduced from 10 to minimize Neon connection limit issues
        min: 0,
        idleTimeoutMillis: 300000, // 5 minutes (Neon free tier disconnects after ~5 min idle)
        // Extended timeout for external databases with SSL/TLS handshake and SASL channel binding
        connectionTimeoutMillis: 30000, // 30 seconds (Neon pooler is fast when responsive)
        statement_timeout: 60000,
        keepalives: 1,
        keepalives_idle: 5, // Send TCP keepalive every 5 seconds to prevent idle disconnection
      };


      // Use connection string if provided (Neon uses this)
      if (connectionConfig.connectionString) {
        const connStr = connectionConfig.connectionString;

        // Parse the connection string to extract individual components.
        // We build the pool from individual fields (not connectionString) so we can:
        //  1. Force IPv4 DNS (Docker resolves IPv6 first; pg picks the first address and fails)
        //  2. Pass ssl.servername for SNI (Neon requires the hostname in the TLS handshake to route the connection)
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(connStr);
        } catch {
          throw new Error(`Invalid connection string: cannot parse URL`);
        }

        const hostname = parsedUrl.hostname;
        const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 5432;
        const database = parsedUrl.pathname.replace(/^\//, "");
        const user = decodeURIComponent(parsedUrl.username);
        const password = decodeURIComponent(parsedUrl.password);


        // Resolve to IPv4 to avoid Docker/IPv6 routing failures on external hosts (e.g. Neon)
        const ipv4 = await resolveIPv4(hostname);
        if (ipv4) {
          poolConfig.host = ipv4;
        } else {
          poolConfig.host = hostname;
        }

        poolConfig.port = port;
        poolConfig.database = database;
        poolConfig.user = user;
        poolConfig.password = password;

        // Skip SSL for local connections; enable for external hosts (e.g. Neon)
        const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
        if (isLocal) {
        } else {
          poolConfig.ssl = {
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
            servername: hostname,
          };
        }
      } else {
        // Otherwise build from individual components
        poolConfig.host = connectionConfig.host;
        poolConfig.port = connectionConfig.port || 5432;
        poolConfig.database = connectionConfig.database;
        poolConfig.user = connectionConfig.user;
        poolConfig.password = connectionConfig.password;


        // Apply SSL for individual component connections only if explicitly requested
        if (connectionConfig.ssl === true) {
          poolConfig.ssl = {
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
          };
        } else {
        }
      }

      try {
        const pool = new Pool(poolConfig);

        // Add error event handler to log pool errors without crashing
        pool.on("error", (err: Error) => {
          getLogger("db").event("db.pool.error", { pool: `data source ${buildId}`, err });
        });

        // Log when clients fail
        pool.on("connect", () => {
        });

        const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });

        return kysely;
      } catch (error) {
        getLogger("datasource").event("datasource.connection.failed", { what: `Failed to create connection: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
    }

    case "mysql": {
      // dynamic import
      const mysql2 = require("mysql2") as any;
      const pool = mysql2.createPool({
        host: connectionConfig.host,
        port: connectionConfig.port || 3306,
        database: connectionConfig.database,
        user: connectionConfig.user,
        password: connectionConfig.password,
        ssl: connectionConfig.ssl ? { rejectUnauthorized: false } : undefined,
        connectionLimit: 10,
      });
      return new Kysely({ dialect: new MysqlDialect({ pool }) });
    }

    case "mssql": {
      // dynamic import
      const { ConnectionPool: MssqlPool } = require("mssql") as any;
      const pool = new MssqlPool({
        server: connectionConfig.host,
        port: connectionConfig.port || 1433,
        database: connectionConfig.database,
        user: connectionConfig.user,
        password: connectionConfig.password,
        options: {
          encrypt: !!connectionConfig.ssl,
          trustServerCertificate: true,
        },
      });
      return new Kysely({
        dialect: new MssqlDialect({
          tarn: { min: 0, max: 10 },
          tedious: { connectionFactory: () => pool },
        } as any),
      });
    }

    default:
      throw new Error(`Unsupported database client type: ${clientType}`);
  }
}

export async function getConnection(dataSource: DataSource): Promise<AnyKysely> {
  const poolKey = dataSource.id;

  if (connectionPool[poolKey]) {
    try {
      await sql`SELECT 1`.execute(connectionPool[poolKey]);
      return connectionPool[poolKey];
    } catch (error) {
      // Log the connection error for debugging
      const errorMsg = error instanceof Error ? error.message : String(error);
      getLogger("datasource").event("datasource.connection.degraded", { what: `Cached connection failed for ${poolKey}: ${errorMsg}. Recreating...` });
      try {
        await connectionPool[poolKey].destroy();
      } catch (destroyError) {
        getLogger("datasource").event("datasource.connection.degraded", { what: `Error destroying failed connection: ${destroyError}` });
      }
      delete connectionPool[poolKey];
    }
  }

  let connectionConfig: ConnectionConfig;
  let needsEncryption = false;

  try {
    const isEncrypted =
      dataSource.connection_config.length > 64 &&
      /^[0-9a-fA-F]+$/.test(dataSource.connection_config);

    if (isEncrypted) {
      const decryptedConfig = decrypt(dataSource.connection_config);
      connectionConfig = JSON.parse(decryptedConfig);
    } else {
      connectionConfig = JSON.parse(dataSource.connection_config);
      needsEncryption = true;
    }
  } catch (error) {
    getLogger("datasource").event("datasource.connection.failed", { what: "Failed to parse connection config", err: error });
    throw error;
  }

  if (needsEncryption) {
    try {
      const { encrypt } = await import("@/lib/security/encryption");
      const encryptedConfig = encrypt(JSON.stringify(connectionConfig));
      const db = getDb();
      db.updateTable("data_sources")
        .set({ connection_config: encryptedConfig })
        .where("id", "=", dataSource.id)
        .execute()
        .catch((err) =>
          getLogger("datasource").event("datasource.connection.failed", { what: "Failed to save re-encrypted config", err: err })
        );
    } catch (error) {
      getLogger("datasource").event("datasource.connection.failed", { what: "Failed to re-encrypt config", err: error });
    }
  }

  const connection = await buildKyselyConnection(dataSource.client_type, connectionConfig);

  await sql`SELECT 1`.execute(connection);

  connectionPool[poolKey] = connection;
  return connection;
}

export async function testConnection(
  clientType: DatabaseClientType,
  connectionConfig: ConnectionConfig
): Promise<{ success: boolean; message: string; latency?: number }> {
  const startTime = Date.now();
  let connection: AnyKysely | null = null;
  const testId = Math.random().toString(36).substring(7);

  // Log test initiation with connection details
  if (connectionConfig.connectionString) {
    const connStrMask = connectionConfig.connectionString.replace(/:[^@]+@/, `:***@`);
  } else {
  }

  try {
    connection = await buildKyselyConnection(clientType, connectionConfig);

    // Test basic connectivity
    const connectTime = Date.now() - startTime;
    await sql`SELECT 1`.execute(connection);
    const queryTime = Date.now() - startTime - connectTime;

    // For PostgreSQL, also verify schema access (what inspect needs)
    if (clientType === "pg") {
      try {
        const schemaStartTime = Date.now();
        await sql`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          LIMIT 1
        `.execute(connection);
        const schemaDuration = Date.now() - schemaStartTime;
      } catch (schemaError) {
        const schemaMsg = schemaError instanceof Error ? schemaError.message : String(schemaError);
        throw new Error(
          `Schema access failed: ${schemaMsg}. ` +
            `The user may not have permissions to query information_schema.`
        );
      }
    }

    const latency = Date.now() - startTime;

    if (clientType === "sqlite3") {
      return {
        success: true,
        message: "Connection successful (SQLite)",
        latency,
      };
    }

    return {
      success: true,
      message: `Connection successful (${latency}ms)`,
      latency,
    };
  } catch (error) {
    const errorDuration = Date.now() - startTime;
    let message = "Unknown error";
    let errorCode = "";
    let errorStack = "";

    if (error instanceof Error) {
      message = error.message;
      errorCode = (error as any).code || "";
      errorStack = error.stack || "";
    } else if (typeof error === "object" && error !== null) {
      errorCode = (error as any).code || "";
      message = (error as any).message || String(error);
      errorStack = (error as any).stack || "";
    }

    // One event, with the cause: the code, how long it took, and the stack. The configuration
    // is not logged: it holds the host and user, and a connection string is a credential.
    getLogger("datasource").event("datasource.test.failed", {
      errorCode: errorCode || "UNKNOWN",
      durationMs: errorDuration,
      err: error,
    });

    // Provide helpful error messages
    let friendlyMessage = message || "Unknown error";
    const errorText = `${message} ${errorCode}`.toUpperCase();

    if (
      errorCode === "ETIMEDOUT" ||
      errorText.includes("ETIMEDOUT") ||
      errorText.includes("TIMEOUT")
    ) {
      friendlyMessage = `Connection timeout (${errorDuration}ms). The database server may be unreachable, the network may be blocking the connection, or the SSL/TLS handshake is taking too long. Check: (1) DNS resolution, (2) firewall rules, (3) network connectivity to the database host.`;
    } else if (errorCode === "ECONNREFUSED" || errorText.includes("ECONNREFUSED")) {
      friendlyMessage = `Connection refused. The database server rejected the connection. Check: (1) host and port are correct, (2) database server is running and accepting connections.`;
    } else if (
      errorCode === "ENOTFOUND" ||
      errorText.includes("ENOTFOUND") ||
      errorText.includes("GETADDRINFO")
    ) {
      friendlyMessage = `Host not found. DNS resolution failed for the database host. Check: (1) hostname is spelled correctly, (2) DNS resolution is working, (3) network connectivity to DNS servers.`;
    } else if (errorText.includes("AUTHENTICATION") || errorText.includes("PASSWORD")) {
      friendlyMessage = `Authentication failed. The database rejected the credentials. Check: (1) username and password are correct, (2) user has access to the specified database.`;
    } else if (errorText.includes("SCHEMA ACCESS")) {
      friendlyMessage = message; // Already formatted
    }

    return {
      success: false,
      message: friendlyMessage,
    };
  } finally {
    if (connection) {
      const destroyStart = Date.now();
      await connection.destroy();
      const destroyDuration = Date.now() - destroyStart;
    }
  }
}

export async function closeConnection(dataSourceId: string): Promise<void> {
  if (connectionPool[dataSourceId]) {
    await connectionPool[dataSourceId].destroy();
    delete connectionPool[dataSourceId];
  }
}

export async function closeAllConnections(): Promise<void> {
  await Promise.all(
    Object.keys(connectionPool).map(async (key) => {
      await connectionPool[key].destroy();
      delete connectionPool[key];
    })
  );
}

export function getConnectionManager() {
  return { getConnection, closeConnection, closeAllConnections };
}

export function getActiveConnections(): string[] {
  return Object.keys(connectionPool);
}
