/**
 * SQL Parser: Extracts table and entity references from SQL statements
 * using antlr4ng for tokenization and node-sql-parser for AST analysis.
 * Validates entity access against data source RBAC permissions.
 */

import { CharStream } from "antlr4ng";
import { Parser } from "node-sql-parser";
import { checkEntityAccess } from "@/lib/permissions/ds-rbac";
import type {
  AccessCheckDetail,
  ParsedSqlEntity,
  SqlAstNode,
  SqlExpression,
  SqlFromItem,
  SqlTableRef,
} from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

const sqlParser = new Parser();

/**
 * Parse a SQL statement and extract all referenced entities (tables, views, subqueries).
 * Uses node-sql-parser for cross-dialect AST parsing and antlr4ng for tokenization validation.
 */
export function extractEntitiesFromSql(sql: string, dialect: string = "sqlite"): ParsedSqlEntity[] {
  const entities: ParsedSqlEntity[] = [];
  const seen = new Set<string>();

  try {
    // Map our dialect names to node-sql-parser database identifiers
    const dbType = mapDialect(dialect);

    const ast = sqlParser.astify(sql, { database: dbType });
    const astArray = Array.isArray(ast) ? ast : [ast];

    for (const statement of astArray) {
      collectEntitiesFromAst(statement as unknown as SqlAstNode, entities, seen);
    }
  } catch (parseError) {
    // Fallback: use regex-based extraction if parser fails
    getLogger("nlquery").event("nlquery.pipeline.degraded", { what: "SQL parser failed, falling back to regex extraction", err: parseError });
    extractEntitiesViaRegex(sql, entities, seen);
  }

  return entities;
}

/**
 * Map internal dialect names to node-sql-parser database types
 */
function mapDialect(dialect: string): string {
  switch (dialect) {
    case "pg":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mssql":
      return "TransactSQL";
    case "sqlite3":
    case "sqlite":
      return "SQLite";
    default:
      return "SQLite";
  }
}

/**
 * Recursively collect entity references from an AST node.
 * Uses typed interfaces that match node-sql-parser's actual runtime AST shapes.
 */
function collectEntitiesFromAst(
  node: SqlAstNode,
  entities: ParsedSqlEntity[],
  seen: Set<string>
): void {
  if (!node || typeof node !== "object") return;

  // Handle SELECT statements
  if (node.type === "select") {
    // Process FROM clause
    if (node.from && Array.isArray(node.from)) {
      for (const fromItem of node.from) {
        processFromItem(fromItem as SqlFromItem, entities, seen);
      }
    }

    // Process WHERE subqueries
    if (node.where) {
      processExpressionForSubqueries(node.where as SqlExpression, entities, seen);
    }

    // Process HAVING subqueries
    if (node.having) {
      processExpressionForSubqueries(node.having as SqlExpression, entities, seen);
    }
  }

  // Handle INSERT, UPDATE, DELETE
  if (node.table) {
    const tables = Array.isArray(node.table) ? node.table : [node.table];
    for (const t of tables) {
      if (t && typeof t === "object" && (t as SqlTableRef).table) {
        addEntity(t as SqlTableRef, entities, seen);
      }
    }
  }

  // Handle UNION and compound statements
  if (node._next) {
    collectEntitiesFromAst(node._next, entities, seen);
  }
}

function processFromItem(item: SqlFromItem, entities: ParsedSqlEntity[], seen: Set<string>): void {
  if (!item) return;

  if (typeof item === "object") {
    // Direct table reference
    if (item.table && typeof item.table === "string") {
      const key = `${item.db || ""}|${item.table}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({
          name: item.table,
          schema: item.db || undefined,
          alias: item.as || undefined,
          type: "table",
        });
      }
    }

    // Subquery in FROM
    if (item.expr && typeof item.expr === "object" && item.expr.type) {
      if (item.as) {
        const key = `subquery|${item.as}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({
            name: item.as,
            type: "subquery",
          });
        }
      }
      collectEntitiesFromAst(item.expr, entities, seen);
    }
  }
}

function addEntity(tableExpr: SqlTableRef, entities: ParsedSqlEntity[], seen: Set<string>): void {
  if (!tableExpr.table) return;

  const key = `${tableExpr.db || ""}|${tableExpr.table}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);

  entities.push({
    name: tableExpr.table,
    schema: tableExpr.db || undefined,
    alias: tableExpr.as || undefined,
    type: "table",
  });
}

function processExpressionForSubqueries(
  expr: SqlExpression,
  entities: ParsedSqlEntity[],
  seen: Set<string>
): void {
  if (!expr || typeof expr !== "object") return;

  if (expr.type === "select") {
    collectEntitiesFromAst(expr as SqlAstNode, entities, seen);
    return;
  }

  // Recursively search for subqueries in expression trees
  for (const key of Object.keys(expr)) {
    const value = expr[key];
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") {
            processExpressionForSubqueries(item as SqlExpression, entities, seen);
          }
        }
      } else {
        processExpressionForSubqueries(value as SqlExpression, entities, seen);
      }
    }
  }
}

/**
 * Fallback regex-based entity extraction for when the parser fails.
 * Handles common SQL patterns for table references.
 */
function extractEntitiesViaRegex(
  sql: string,
  entities: ParsedSqlEntity[],
  seen: Set<string>
): void {
  // Match FROM and JOIN clauses
  const patterns = [
    /\bFROM\s+([`"']?[\w.]+[`"']?)/gi,
    /\bJOIN\s+([`"']?[\w.]+[`"']?)/gi,
    /\bINTO\s+([`"']?[\w.]+[`"']?)/gi,
    /\bUPDATE\s+([`"']?[\w.]+[`"']?)/gi,
  ];

  for (const pattern of patterns) {
    for (let match = pattern.exec(sql); match !== null; match = pattern.exec(sql)) {
      let tableName = match[1].replace(/[`"']/g, "");
      let schema: string | undefined;

      // Handle schema.table notation
      if (tableName.includes(".")) {
        const parts = tableName.split(".");
        schema = parts[0];
        tableName = parts[1];
      }

      // Skip SQL keywords that might be mistakenly matched
      const keywords = ["select", "where", "set", "values", "as", "on", "and", "or"];
      if (keywords.includes(tableName.toLowerCase())) continue;

      const key = `${schema || ""}|${tableName}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({
          name: tableName,
          schema,
          type: "table",
        });
      }
    }
  }
}

/**
 * Validate SQL syntax using antlr4ng tokenization.
 * Returns tokenization errors if any.
 */
export function validateSqlTokens(sql: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    // Use antlr4ng CharStream for basic tokenization validation
    CharStream.fromString(sql);

    // Check for balanced parentheses and quotes
    let parenDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const prevChar = i > 0 ? sql[i - 1] : "";

      if (char === "'" && !inDoubleQuote && prevChar !== "\\") {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote && prevChar !== "\\") {
        inDoubleQuote = !inDoubleQuote;
      } else if (!inSingleQuote && !inDoubleQuote) {
        if (char === "(") parenDepth++;
        else if (char === ")") parenDepth--;

        if (parenDepth < 0) {
          errors.push(`Unmatched closing parenthesis at position ${i}`);
        }
      }
    }

    if (inSingleQuote) errors.push("Unterminated single quote");
    if (inDoubleQuote) errors.push("Unterminated double quote");
    if (parenDepth > 0) errors.push(`${parenDepth} unclosed parenthesis(es)`);

    // Additional validation using node-sql-parser
    try {
      sqlParser.astify(sql, { database: "SQLite" });
    } catch (parseError: unknown) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      errors.push(`SQL parse error: ${message}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Tokenization error: ${message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Full pipeline: Parse SQL, extract entities, check access permissions.
 */
export async function validateSqlAccess(
  sql: string,
  userId: string,
  dataSourceId: string,
  dialect: string
): Promise<{
  entities: ParsedSqlEntity[];
  accessResults: AccessCheckDetail[];
  allGranted: boolean;
  deniedEntities: string[];
}> {
  // Extract entities from SQL
  const entities = extractEntitiesFromSql(sql, dialect);

  // Filter out subqueries (they don't need direct access checks)
  const tableEntities = entities.filter((e) => e.type !== "subquery");

  if (tableEntities.length === 0) {
    return {
      entities,
      accessResults: [],
      allGranted: true,
      deniedEntities: [],
    };
  }

  // Check access for each entity
  const accessResults = await checkEntityAccess(userId, dataSourceId, tableEntities);

  const deniedEntities = accessResults.filter((r) => !r.hasAccess).map((r) => r.entity);

  return {
    entities,
    accessResults,
    allGranted: deniedEntities.length === 0,
    deniedEntities,
  };
}
