/**
 * SQL AST Validator with RBAC Checks
 *
 * Uses pgsql-ast-parser to:
 * 1. Parse generated SQL into AST
 * 2. Extract all accessed tables/views
 * 3. Validate RBAC permissions for accessed entities
 * 4. Provide detailed access violation reports
 */

import { parse } from "pgsql-ast-parser";
import { checkEntityAccess } from "@/lib/permissions/ds-rbac";
import type { User } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

export interface SQLAccessValidation {
  isValid: boolean;
  accessAllowed: boolean;
  tablesAccessed: string[];
  deniedTables: string[];
  warnings: string[];
  error?: string;
}

/**
 * There is one implementation of "may this user read this table", and it is not
 * in here.
 *
 * This module used to answer that question itself, against
 * `permission_level in ("read", "write", "admin")` — and **no permission the
 * product can create has ever been one of those three**. `checkEntityAccess` in
 * `@/lib/permissions/ds-rbac`, which the execution paths actually gate on,
 * reads the union the type declares and the permissions screen writes:
 * `select | insert | update | delete | all`. Two readings of one fact, and they
 * drifted, exactly as two readings of one fact do.
 *
 * Nothing noticed because nothing had ever *created* a `ds_entity_permissions`
 * row outside a manual test, and with no rows at all this function refuses on
 * the earlier "user has no roles in this data source" branch — the same denial,
 * for a different and entirely plausible reason. Seeding roles from a model's
 * `%%rbac` produced the first rows and with them the real behaviour.
 *
 * So the second implementation is gone. This delegates, which also buys the
 * system-admin bypass and the column restrictions it never had.
 */

/**
 * Extract table names from SQL using AST parser
 */
export function extractTablesFromSQL(sql: string): string[] {
  try {
    const ast = parse(sql);
    const tables = new Set<string>();

    // Traverse AST to find all table references
    traverseAST(ast, (node: any) => {
      // Handle FROM clause table references
      if (node.from && Array.isArray(node.from)) {
        for (const fromClause of node.from) {
          if (fromClause.name) {
            tables.add(fromClause.name);
          } else if (fromClause.table) {
            tables.add(fromClause.table);
          }
        }
      }

      // Handle JOIN clauses
      if (node.join && Array.isArray(node.join)) {
        for (const joinClause of node.join) {
          if (joinClause.on?.left?.table) {
            tables.add(joinClause.on.left.table);
          }
          if (joinClause.table?.name) {
            tables.add(joinClause.table.name);
          }
        }
      }

      // Handle table in WITH (CTE) clauses
      if (node.with && Array.isArray(node.with)) {
        for (const cte of node.with) {
          if (cte.name) {
            tables.add(cte.name);
          }
          // Recursively process CTE definition
          if (cte.statement) {
            const cteTables = extractTablesFromSQL(cte.statement);
            cteTables.forEach((t) => {
              tables.add(t);
            });
          }
        }
      }
    });

    return Array.from(tables);
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "Failed to parse SQL with AST", err: error });
    return [];
  }
}

/**
 * Recursively traverse AST nodes
 */
function traverseAST(node: any, callback: (node: any) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }

  callback(node);

  // Traverse common properties
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        traverseAST(item, callback);
      }
    } else if (typeof value === "object" && value !== null) {
      traverseAST(value, callback);
    }
  }
}

/**
 * Validate SQL RBAC access for a user on a data source
 *
 * Checks that the user's role has permission to access all tables
 * mentioned in the generated SQL
 */
export async function validateSQLRBACAccess(
  userId: string,
  dataSourceId: string,
  sql: string
): Promise<SQLAccessValidation> {
  try {
    // Step 1: Extract tables from SQL
    const tablesAccessed = extractTablesFromSQL(sql);

    if (tablesAccessed.length === 0) {
      return {
        isValid: true,
        accessAllowed: true,
        tablesAccessed: [],
        deniedTables: [],
        warnings: [],
      };
    }

    // Step 2: Ask the one implementation which of them this user may read.
    const results = await checkEntityAccess(
      userId,
      dataSourceId,
      tablesAccessed.map((name) => ({ name, schema: undefined, type: "table" as const }))
    );

    const deniedTables = results.filter((r) => !r.hasAccess).map((r) => r.entity);

    // Step 5: Return validation result
    return {
      isValid: true,
      accessAllowed: deniedTables.length === 0,
      tablesAccessed,
      deniedTables,
      warnings:
        deniedTables.length > 0
          ? [
              `Access denied to tables: ${deniedTables.join(", ")}. These tables are not accessible in your role.`,
            ]
          : [],
      ...(deniedTables.length > 0 && {
        error: `Permission denied for tables: ${deniedTables.join(", ")}`,
      }),
    };
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "RBAC validation error", err: error });
    return {
      isValid: false,
      accessAllowed: false,
      tablesAccessed: [],
      deniedTables: [],
      warnings: [],
      error: `Failed to validate RBAC access: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Check if table exists in accessible schema for a data source
 */
export async function isTableAccessible(
  userId: string,
  dataSourceId: string,
  tableName: string
): Promise<boolean> {
  try {
    // Delegated for the same reason as above: one answer to one question.
    const [result] = await checkEntityAccess(userId, dataSourceId, [
      { name: tableName, schema: undefined, type: "table" as const },
    ]);
    return !!result?.hasAccess;
  } catch (error) {
    getLogger("nlquery").event("nlquery.translate.failed", { what: "Table access check failed", err: error });
    return false;
  }
}
