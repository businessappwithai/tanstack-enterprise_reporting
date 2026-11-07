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
      getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Building PostgreSQL connection...`);

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

      getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Pool config: max=${poolConfig.max}, connectionTimeout=${poolConfig.connectionTimeoutMillis}ms`);

      // Use connection string if provided (Neon uses this)
      if (connectionConfig.connectionString) {
        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Using connection string mode`);
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

        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Parsed: host=${hostname}, port=${port}, db=${database}, user=${user}`);

        // Resolve to IPv4 to avoid Docker/IPv6 routing failures on external hosts (e.g. Neon)
        const ipv4 = await resolveIPv4(hostname);
        if (ipv4) {
          poolConfig.host = ipv4;
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Resolved ${hostname} → IPv4 ${ipv4}`);
        } else {
          poolConfig.host = hostname;
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] IPv4 resolution failed, using hostname directly`);
        }

        poolConfig.port = port;
        poolConfig.database = database;
        poolConfig.user = user;
        poolConfig.password = password;

        // Skip SSL for local connections; enable for external hosts (e.g. Neon)
        const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
        if (isLocal) {
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] SSL disabled (local host)`);
        } else {
          poolConfig.ssl = {
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
            servername: hostname,
          };
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] SSL config: rejectUnauthorized=false, servername=${hostname}`);
        }
      } else {
        // Otherwise build from individual components
        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Using individual field mode`);
        poolConfig.host = connectionConfig.host;
        poolConfig.port = connectionConfig.port || 5432;
        poolConfig.database = connectionConfig.database;
        poolConfig.user = connectionConfig.user;
        poolConfig.password = connectionConfig.password;

        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Connection details: host=${poolConfig.host}:${poolConfig.port}, db=${poolConfig.database}, user=${poolConfig.user}`);

        // Apply SSL for individual component connections only if explicitly requested
        if (connectionConfig.ssl === true) {
          poolConfig.ssl = {
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
          };
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] SSL enabled`);
        } else {
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] SSL disabled (default for local connections)`);
        }
      }

      try {
        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Creating pg Pool...`);
        const pool = new Pool(poolConfig);
        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] pg Pool created successfully`);

        // Add error event handler to log pool errors without crashing
        pool.on("error", (err: Error) => {
          getLogger("db").event("db.pool.error", { pool: `data source ${buildId}`, err });
        });

        // Log when clients fail
        pool.on("connect", () => {
          getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Pool: new client connected`);
        });

        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Creating Kysely instance with PostgreSQL dialect...`);
        const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });
        getLogger("datasource").note("debug", `[BUILD_CONN:${buildId}] Kysely instance created successfully`);

        return kysely;
      } catch (error) {
        getLogger("datasource").note("error", `[BUILD_CONN:${buildId}] Failed to create connection: ${error instanceof Error ? error.message : String(error)}`);
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
      getLogger("datasource").note("warn", `[CONNECTION MANAGER] Cached connection failed for ${poolKey}: ${errorMsg}. Recreating...`);
      try {
        await connectionPool[poolKey].destroy();
      } catch (destroyError) {
        getLogger("datasource").note("warn", `[CONNECTION MANAGER] Error destroying failed connection: ${destroyError}`);
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
    getLogger("datasource").note("error", "[CONNECTION MANAGER] Failed to parse connection config:", { err: error });
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
          getLogger("datasource").note("error", "[CONNECTION MANAGER] Failed to save re-encrypted config:", { err: err })
        );
    } catch (error) {
      getLogger("datasource").note("error", "[CONNECTION MANAGER] Failed to re-encrypt config:", { err: error });
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
  getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] START - Client: ${clientType}`);
  if (connectionConfig.connectionString) {
    const connStrMask = connectionConfig.connectionString.replace(/:[^@]+@/, `:***@`);
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Connection String: ${connStrMask}`);
  } else {
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Host: ${connectionConfig.host}:${connectionConfig.port || "default"}`);
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Database: ${connectionConfig.database}`);
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] User: ${connectionConfig.user}`);
  }

  try {
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Building connection pool...`);
    connection = await buildKyselyConnection(clientType, connectionConfig);
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Connection pool built successfully`);

    // Test basic connectivity
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Testing basic connectivity with SELECT 1...`);
    const connectTime = Date.now() - startTime;
    await sql`SELECT 1`.execute(connection);
    const queryTime = Date.now() - startTime - connectTime;
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Basic connectivity OK (connect: ${connectTime}ms, query: ${queryTime}ms)`);

    // For PostgreSQL, also verify schema access (what inspect needs)
    if (clientType === "pg") {
      getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Testing schema access (information_schema)...`);
      try {
        const schemaStartTime = Date.now();
        await sql`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          LIMIT 1
        `.execute(connection);
        const schemaDuration = Date.now() - schemaStartTime;
        getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Schema access OK (${schemaDuration}ms)`);
      } catch (schemaError) {
        const schemaMsg = schemaError instanceof Error ? schemaError.message : String(schemaError);
        getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] Schema access FAILED: ${schemaMsg}`);
        throw new Error(
          `Schema access failed: ${schemaMsg}. ` +
            `The user may not have permissions to query information_schema.`
        );
      }
    }

    const latency = Date.now() - startTime;
    getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] SUCCESS - Total latency: ${latency}ms`);

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

    // Log detailed error information for admin diagnostics
    getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] FAILED after ${errorDuration}ms`);
    getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] Error Code: ${errorCode || "N/A"}`);
    getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] Error Message: ${message}`);
    if (errorStack) {
      getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] Stack Trace:\n${errorStack}`);
    }
    getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] Config Summary: ${JSON.stringify({
        clientType,
        host: connectionConfig.host,
        port: connectionConfig.port,
        database: connectionConfig.database,
        hasConnectionString: !!connectionConfig.connectionString,
        connectionStringHost:
          connectionConfig.connectionString?.split("@")[1]?.split(":")[0] || "N/A",
      })}`);

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

    getLogger("datasource").note("error", `[TEST_CONNECTION:${testId}] User-facing message: ${friendlyMessage}`);

    return {
      success: false,
      message: friendlyMessage,
    };
  } finally {
    if (connection) {
      const destroyStart = Date.now();
      await connection.destroy();
      const destroyDuration = Date.now() - destroyStart;
      getLogger("datasource").note("debug", `[TEST_CONNECTION:${testId}] Connection destroyed (${destroyDuration}ms)`);
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
