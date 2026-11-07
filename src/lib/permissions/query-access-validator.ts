/**
 * Query Access Validator: RBAC pre-flight check (D5)
 *
 * Before executing SQL, validates that the manager's role has permission
 * to access all tables and columns in the query
 */

import { checkEntityAccess } from "@/lib/permissions/ds-rbac";
import { extractColumns, extractTablesStrict } from "@/lib/sql/antlr-validator";
import type { User } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

export interface QueryAccessValidation {
  allowed: boolean;
  deniedTables?: string[];
  deniedColumns?: string[];
  reason?: string;
  details?: {
    tablesAccessed: string[];
    columnsAccessed: string[];
    checkedAt: number;
  };
}

export interface ParsedSqlEntity {
  name: string;
  schema?: string;
  type: "table" | "view" | "subquery";
}

/**
 * Validate that a manager has access to all tables and columns in a query (D5)
 *
 * Uses existing RBAC system (ds-rbac.ts) which checks:
 * 1. Table-level permissions
 * 2. Column restrictions
 * 3. Row filters (role-based)
 */
export async function validateQueryAccess(
  manager: User,
  sql: string,
  dataSourceId: string
): Promise<QueryAccessValidation> {
  try {
    /*
     * 1. Which base tables does this statement read?
     *
     * A query whose tables cannot be determined is REFUSED, and that is the
     * whole point of this block. It used to read:
     *
     *     if (tables.length === 0) return { allowed: true };
     *
     * with a comment saying "trust it for now". The extractor behind it was a
     * regular expression, so every statement it failed to match produced no
     * tables and was therefore trusted — `SELECT * FROM(hr_salaries)`, and the
     * same statement with a block comment where the space goes, among them.
     * Deleting one space bypassed the entire data-source permission layer.
     *
     * An access decision that cannot be made is a denial. There is no third
     * answer, and "no tables named" is not evidence that a query reads nothing
     * — it is evidence that this function does not understand the query.
     */
    const extraction = extractTablesStrict(sql);
    if (!extraction.ok) {
      return {
        allowed: false,
        reason:
          "This query could not be analysed for table access, so it was not run. " +
          "Rewrite it in plain SELECT form, or save it as a report if it needs " +
          `constructs the analyser does not cover. (${extraction.reason})`,
      };
    }

    const tables = extraction.tables;
    const columns = extractColumns(sql);

    // A statement that genuinely reads no table — `SELECT 1`, `SELECT now()` —
    // touches no data and so has nothing to check. This is narrow on purpose:
    // it is reached only when the parser succeeded and reported no tables,
    // never when parsing failed.
    if (tables.length === 0) {
      return {
        allowed: true,
        details: { tablesAccessed: [], columnsAccessed: columns, checkedAt: Date.now() },
      };
    }

    // 2. Parse SQL entities (convert to format expected by checkEntityAccess)
    const entities: ParsedSqlEntity[] = tables.map((table) => ({
      name: table,
      schema: undefined,
      type: "table" as const,
    }));

    // 3. Check entity access using existing RBAC system
    const accessResults = await checkEntityAccess(manager.id, dataSourceId, entities);

    // 4. Analyze results for denials
    const deniedTables: string[] = [];
    const deniedColumns: string[] = [];

    for (const result of accessResults) {
      // Check table access
      if (!result.hasAccess) {
        deniedTables.push(result.entity);
        continue;
      }

      // Check column-level restrictions
      if (result.columnRestrictions && result.columnRestrictions.length > 0) {
        const allowedCols = new Set(result.columnRestrictions);
        const queriedCols = columns.filter(
          (col) => col.toLowerCase().startsWith(`${result.entity.toLowerCase()}.`) || col === "*" // Wildcard check
        );

        for (const col of queriedCols) {
          const colName = col.includes(".") ? col.split(".")[1] : col;
          if (colName !== "*" && !allowedCols.has(colName)) {
            deniedColumns.push(`${result.entity}.${colName}`);
          }
        }
      }
    }

    // 5. Return validation result
    if (deniedTables.length > 0) {
      return {
        allowed: false,
        deniedTables,
        reason: `You don't have permission to access: ${deniedTables.join(", ")}`,
        details: {
          tablesAccessed: tables,
          columnsAccessed: columns,
          checkedAt: Date.now(),
        },
      };
    }

    if (deniedColumns.length > 0) {
      return {
        allowed: false,
        deniedColumns,
        reason: `You don't have permission to access columns: ${deniedColumns.join(", ")}`,
        details: {
          tablesAccessed: tables,
          columnsAccessed: columns,
          checkedAt: Date.now(),
        },
      };
    }

    // All access granted
    return {
      allowed: true,
      details: {
        tablesAccessed: tables,
        columnsAccessed: columns,
        checkedAt: Date.now(),
      },
    };
  } catch (error) {
    getLogger("auth").note("error", "[QueryAccess] Validation error:", { err: error });
    // On error, deny access (fail-safe)
    return {
      allowed: false,
      reason: "Access validation failed. Please try again or contact support.",
    };
  }
}

/**
 * Get accessible entities for a manager in a data source
 * Used for schema browsing and discovery
 */
export async function getAccessibleEntities(
  userId: string,
  dataSourceId: string
): Promise<string[]> {
  try {
    const { getUserAccessibleEntities } = await import("@/lib/permissions/ds-rbac");
    const entities = await getUserAccessibleEntities(userId, dataSourceId);
    return entities.map((e) => e.entity_name);
  } catch (error) {
    getLogger("auth").note("error", "[QueryAccess] Failed to get accessible entities:", { err: error });
    return [];
  }
}

/**
 * Get column-level restrictions for a manager on a specific table
 */
export async function getColumnRestrictions(
  userId: string,
  dataSourceId: string,
  tableName: string
): Promise<string[] | undefined> {
  try {
    const { getUserAccessibleEntities } = await import("@/lib/permissions/ds-rbac");
    const entities = await getUserAccessibleEntities(userId, dataSourceId);

    const tableEntity = entities.find(
      (e) => e.entity_name.toLowerCase() === tableName.toLowerCase()
    );

    if (!tableEntity?.column_restrictions) {
      return undefined; // No restrictions
    }

    return JSON.parse(tableEntity.column_restrictions);
  } catch (error) {
    getLogger("auth").note("error", "[QueryAccess] Failed to get column restrictions:", { err: error });
    return undefined;
  }
}
