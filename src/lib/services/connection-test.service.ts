import { testConnection as testDatabaseConnection } from "@/lib/db/connection-manager";
import type { DatabaseClientType } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filename?: string;
  connectionString?: string;
}

export interface ConnectionTestResult {
  connected: boolean;
  message: string;
  latency?: number;
}

export class ConnectionTestService {
  static async test(clientType: string, config: ConnectionConfig): Promise<ConnectionTestResult> {
    const serviceId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    if (!clientType?.trim()) {
      getLogger("datasource").note("warn", `[SERVICE:${serviceId}] Database type is required`);
      return {
        connected: false,
        message: "Database type is required",
      };
    }

    try {
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Starting connection test`);
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Client type: ${clientType}`);

      // First validate the config
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Step 1: Validating configuration...`);
      const validationResult = this.validateConfig(clientType, config);
      if (!validationResult.valid) {
        const duration = Date.now() - startTime;
        getLogger("datasource").note("warn", `[SERVICE:${serviceId}] Config validation FAILED after ${duration}ms: ${validationResult.message}`);
        return {
          connected: false,
          message: validationResult.message,
        };
      }
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Step 1: Config validation OK`);

      // Then actually test the connection (real database connectivity)
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Step 2: Testing actual database connection...`);
      const result = await testDatabaseConnection(
        clientType.toLowerCase() as DatabaseClientType,
        config
      );

      const duration = Date.now() - startTime;
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Step 2: Connection test completed in ${duration}ms`);
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Result: success=${result.success}, latency=${result.latency}ms`);
      getLogger("datasource").note("debug", `[SERVICE:${serviceId}] Message: ${result.message}`);

      return {
        connected: result.success,
        message: result.message,
        latency: result.latency,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : "Connection test failed";
      const errorCode = error instanceof Error ? (error as any).code : "UNKNOWN";
      const errorStack = error instanceof Error ? error.stack : "";

      getLogger("datasource").note("error", `[SERVICE:${serviceId}] EXCEPTION after ${duration}ms`);
      getLogger("datasource").note("error", `[SERVICE:${serviceId}] Error Code: ${errorCode}`);
      getLogger("datasource").note("error", `[SERVICE:${serviceId}] Error Message: ${message}`);
      if (errorStack) {
        getLogger("datasource").note("error", `[SERVICE:${serviceId}] Stack Trace:\n${errorStack}`);
      }

      return {
        connected: false,
        message,
      };
    }
  }

  private static validateConfig(
    clientType: string,
    config: ConnectionConfig
  ): { valid: boolean; message: string } {
    const type = clientType.toLowerCase();

    switch (type) {
      case "sqlite":
      case "sqlite3":
        if (!config.filename?.trim()) {
          return {
            valid: false,
            message: "SQLite filename is required",
          };
        }
        break;

      case "pg":
      case "postgres":
      case "postgresql":
        if (config.connectionString) {
          if (!config.connectionString.trim()) {
            return {
              valid: false,
              message: "Connection string cannot be empty",
            };
          }
        } else {
          if (!config.host || !config.database || !config.user) {
            const missing = [];
            if (!config.host) missing.push("host");
            if (!config.database) missing.push("database");
            if (!config.user) missing.push("user");
            return {
              valid: false,
              message: `Missing required fields: ${missing.join(", ")}`,
            };
          }
        }
        break;

      case "mysql":
        if (config.connectionString) {
          if (!config.connectionString.trim()) {
            return {
              valid: false,
              message: "Connection string cannot be empty",
            };
          }
        } else {
          if (!config.host || !config.database || !config.user) {
            const missing = [];
            if (!config.host) missing.push("host");
            if (!config.database) missing.push("database");
            if (!config.user) missing.push("user");
            return {
              valid: false,
              message: `Missing required fields: ${missing.join(", ")}`,
            };
          }
        }
        break;

      case "mssql":
      case "sqlserver":
        if (config.connectionString) {
          if (!config.connectionString.trim()) {
            return {
              valid: false,
              message: "Connection string cannot be empty",
            };
          }
        } else {
          if (!config.host || !config.database || !config.user) {
            const missing = [];
            if (!config.host) missing.push("host");
            if (!config.database) missing.push("database");
            if (!config.user) missing.push("user");
            return {
              valid: false,
              message: `Missing required fields: ${missing.join(", ")}`,
            };
          }
        }
        break;

      case "oracle":
      case "oracledb":
        if (config.connectionString) {
          if (!config.connectionString.trim()) {
            return {
              valid: false,
              message: "Connection string cannot be empty",
            };
          }
        } else {
          if (!config.host || !config.database || !config.user) {
            const missing = [];
            if (!config.host) missing.push("host");
            if (!config.database) missing.push("database");
            if (!config.user) missing.push("user");
            return {
              valid: false,
              message: `Missing required fields: ${missing.join(", ")}`,
            };
          }
        }
        break;

      default:
        return {
          valid: false,
          message: `Unsupported database type: ${clientType}`,
        };
    }

    return { valid: true, message: "" };
  }
}
