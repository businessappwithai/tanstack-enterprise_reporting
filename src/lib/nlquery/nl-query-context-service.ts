/**
 * NL Query Context Service
 *
 * Manages storage and retrieval of successful NL→SQL translations
 * Uses pgvector for semantic similarity matching
 * Provides context for Mastra agent to improve query generation
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/config";
import { getLogger } from "@/lib/logging/logger";

export interface QueryAnalysis {
  queryType: "SELECT" | "JOIN" | "AGGREGATE" | "WINDOW" | "UNION" | "CTE";
  tableCount: number;
  joinCount: number;
  hasAggregation: boolean;
  hasWindowFunction: boolean;
}

export interface NLQueryContextInput {
  dataSourceId: string;
  userId: string;
  roleName: string;
  nlQuestion: string;
  generatedSQL: string;
  nlQuestionEmbedding?: number[];
  schemaContext: Record<string, unknown>;
  rbacContext: Record<string, unknown>;
  fieldInstructions?: Record<string, unknown>;
  executionTimeMs: number;
  rowCount: number;
  wasSuccessful: boolean;
  errorMessage?: string;
  translationConfidence: number;
  llmConfidence: number;
}

export interface SimilarQuery {
  id: string;
  nlQuestion: string;
  generatedSQL: string;
  fieldInstructions?: Record<string, unknown>;
  executionTimeMs: number;
  rowCount: number;
  translationConfidence: number;
  similarity: number;
}

/**
 * Analyze SQL query structure
 */
function analyzeSQLQuery(sql: string): QueryAnalysis {
  const upperSql = sql.toUpperCase();

  // Count tables (basic heuristic)
  const tableMatches = sql.match(/FROM\s+(\w+)|JOIN\s+(\w+)/gi) || [];
  const tableCount = new Set(tableMatches).size;

  // Count JOINs
  const joinCount = (sql.match(/JOIN/gi) || []).length;

  // Check for aggregation
  const hasAggregation = /GROUP\s+BY|SUM|COUNT|AVG|MAX|MIN/i.test(sql);

  // Check for window functions
  const hasWindowFunction = /OVER\s*\(/i.test(sql);

  // Determine query type
  let queryType: QueryAnalysis["queryType"] = "SELECT";
  if (joinCount > 0) queryType = "JOIN";
  if (hasAggregation) queryType = "AGGREGATE";
  if (hasWindowFunction) queryType = "WINDOW";
  if (/UNION/i.test(sql)) queryType = "UNION";
  if (/WITH\s+\w+\s+AS/i.test(sql)) queryType = "CTE";

  return {
    queryType,
    tableCount,
    joinCount,
    hasAggregation,
    hasWindowFunction,
  };
}

/**
 * Store a successful NL query with context
 */
export async function storeNLQueryContext(input: NLQueryContextInput): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const analysis = analyzeSQLQuery(input.generatedSQL);

  // Store the query
  await db
    .insertInto("nl_query_context")
    .values({
      id,
      data_source_id: input.dataSourceId,
      user_id: input.userId,
      role_name: input.roleName,
      nl_question: input.nlQuestion,
      generated_sql: input.generatedSQL,
      nl_question_embedding: input.nlQuestionEmbedding
        ? JSON.stringify(input.nlQuestionEmbedding)
        : null,
      schema_context: JSON.stringify(input.schemaContext),
      rbac_context: JSON.stringify(input.rbacContext),
      field_instructions: input.fieldInstructions ? JSON.stringify(input.fieldInstructions) : null,
      execution_time_ms: input.executionTimeMs,
      row_count: input.rowCount,
      was_successful: input.wasSuccessful,
      error_message: input.errorMessage || null,
      translation_confidence: input.translationConfidence,
      llm_confidence: input.llmConfidence,
      query_type: analysis.queryType,
      table_count: analysis.tableCount,
      join_count: analysis.joinCount,
      has_aggregation: analysis.hasAggregation,
      has_window_function: analysis.hasWindowFunction,
      created_by: input.userId,
      created_at: new Date().toISOString(),
    })
    .execute();

  // Update role statistics
  await updateRoleStats(input.dataSourceId, input.roleName, input.wasSuccessful);

  return id;
}

/**
 * Find similar successful queries for a role using pgvector
 */
export async function findSimilarQueries(
  dataSourceId: string,
  roleName: string,
  nlQuestionEmbedding?: number[],
  limit: number = 5
): Promise<SimilarQuery[]> {
  const db = getDb();

  if (!nlQuestionEmbedding || nlQuestionEmbedding.length === 0) {
    // Fallback: Get most recent successful queries for the role
    const results = await db
      .selectFrom("nl_query_context")
      .select([
        "id",
        "nl_question",
        "generated_sql",
        "field_instructions",
        "execution_time_ms",
        "row_count",
        "translation_confidence",
      ])
      .where("data_source_id", "=", dataSourceId)
      .where("role_name", "=", roleName)
      .where("was_successful", "=", true)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();

    return results.map((r: any) => ({
      id: r.id,
      nlQuestion: r.nl_question,
      generatedSQL: r.generated_sql,
      fieldInstructions: r.field_instructions ? JSON.parse(r.field_instructions) : undefined,
      executionTimeMs: r.execution_time_ms,
      rowCount: r.row_count,
      translationConfidence: r.translation_confidence,
      similarity: 0.8, // Fallback similarity score
    }));
  }

  // Use pgvector for semantic similarity
  const embeddingString = `[${nlQuestionEmbedding.join(",")}]`;

  try {
    // Use Kysely's raw query for pgvector similarity search
    const results = await (db as any).raw.query(
      `
      SELECT
        id,
        nl_question,
        generated_sql,
        field_instructions,
        execution_time_ms,
        row_count,
        translation_confidence,
        1 - (nl_question_embedding <=> $1::vector) as similarity
      FROM nl_query_context
      WHERE data_source_id = $2
        AND role_name = $3
        AND was_successful = true
        AND nl_question_embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT $4
      `,
      [embeddingString, dataSourceId, roleName, limit]
    );

    return (results as any[]).map((r) => ({
      id: r.id,
      nlQuestion: r.nl_question,
      generatedSQL: r.generated_sql,
      fieldInstructions: r.field_instructions ? JSON.parse(r.field_instructions) : undefined,
      executionTimeMs: r.execution_time_ms,
      rowCount: r.row_count,
      translationConfidence: r.translation_confidence,
      similarity: r.similarity,
    }));
  } catch (error) {
    getLogger("nlquery").note("warn", "[NLQueryContext] pgvector query failed, using fallback", { err: error });
    // Fallback to non-vector query
    return findSimilarQueries(dataSourceId, roleName, undefined, limit);
  }
}

/**
 * Get role statistics and success patterns
 */
export async function getRoleQueryStats(
  dataSourceId: string,
  roleName: string
): Promise<Record<string, unknown> | null> {
  const db = getDb();

  const stats = await db
    .selectFrom("nl_query_role_stats")
    .selectAll()
    .where("data_source_id", "=", dataSourceId)
    .where("role_name", "=", roleName)
    .executeTakeFirst();

  if (!stats) {
    return null;
  }

  return {
    totalQueries: stats.total_queries,
    successfulQueries: stats.successful_queries,
    failedQueries: stats.failed_queries,
    successRate: stats.success_rate,
    avgExecutionTime: stats.avg_execution_time_ms,
    avgRowsReturned: stats.avg_rows_returned,
    avgConfidence: stats.avg_confidence,
    commonQueryTypes: stats.common_query_types ? JSON.parse(stats.common_query_types) : null,
    commonTables: stats.common_tables ? JSON.parse(stats.common_tables) : null,
    commonJoins: stats.common_joins ? JSON.parse(stats.common_joins) : null,
  };
}

/**
 * Update role statistics after query execution
 */
async function updateRoleStats(
  dataSourceId: string,
  roleName: string,
  wasSuccessful: boolean
): Promise<void> {
  const db = getDb();

  // Get or create stats record
  const stats = await db
    .selectFrom("nl_query_role_stats")
    .selectAll()
    .where("data_source_id", "=", dataSourceId)
    .where("role_name", "=", roleName)
    .executeTakeFirst();

  if (!stats) {
    // Create new stats record
    await db
      .insertInto("nl_query_role_stats")
      .values({
        id: randomUUID(),
        role_name: roleName,
        data_source_id: dataSourceId,
        total_queries: 1,
        successful_queries: wasSuccessful ? 1 : 0,
        failed_queries: wasSuccessful ? 0 : 1,
        success_rate: wasSuccessful ? 100 : 0,
        updated_at: new Date().toISOString(),
      })
      .execute();
  } else {
    // Update existing stats
    const newTotal = (stats.total_queries || 0) + 1;
    const newSuccessful = (stats.successful_queries || 0) + (wasSuccessful ? 1 : 0);
    const newFailed = (stats.failed_queries || 0) + (wasSuccessful ? 0 : 1);
    const newSuccessRate = (newSuccessful / newTotal) * 100;

    // Recalculate averages from recent queries
    const recentQueries = await db
      .selectFrom("nl_query_context")
      .select(["execution_time_ms", "row_count", "translation_confidence"])
      .where("data_source_id", "=", dataSourceId)
      .where("role_name", "=", roleName)
      .where("was_successful", "=", true)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();

    const avgExecutionTime =
      recentQueries.length > 0
        ? recentQueries.reduce((sum: number, q: any) => sum + (q.execution_time_ms || 0), 0) /
          recentQueries.length
        : 0;

    const avgRowsReturned =
      recentQueries.length > 0
        ? recentQueries.reduce((sum: number, q: any) => sum + (q.row_count || 0), 0) /
          recentQueries.length
        : 0;

    const avgConfidence =
      recentQueries.length > 0
        ? recentQueries.reduce((sum: number, q: any) => sum + (q.translation_confidence || 0), 0) /
          recentQueries.length
        : 0;

    await db
      .updateTable("nl_query_role_stats")
      .set({
        total_queries: newTotal,
        successful_queries: newSuccessful,
        failed_queries: newFailed,
        success_rate: newSuccessRate,
        avg_execution_time_ms: avgExecutionTime,
        avg_rows_returned: avgRowsReturned,
        avg_confidence: avgConfidence,
        updated_at: new Date().toISOString(),
      })
      .where("data_source_id", "=", dataSourceId)
      .where("role_name", "=", roleName)
      .execute();
  }
}

/**
 * Build context prompt for Mastra agent using similar successful queries
 */
export async function buildMastraContextPrompt(
  dataSourceId: string,
  roleName: string,
  nlQuestion: string,
  schemaContext: string,
  nlQuestionEmbedding?: number[]
): Promise<string> {
  // Get similar successful queries
  const similarQueries = await findSimilarQueries(dataSourceId, roleName, nlQuestionEmbedding, 3);

  // Get role stats
  const roleStats = await getRoleQueryStats(dataSourceId, roleName);

  let contextPrompt = `
DATABASE SCHEMA:
${schemaContext}

ROLE CONTEXT:
- Role: ${roleName}
- Success Rate: ${roleStats?.successRate || "N/A"}%
- Average Query Execution Time: ${roleStats?.avgExecutionTime || "N/A"}ms
- Common Query Types: ${roleStats?.commonQueryTypes ? JSON.stringify(roleStats.commonQueryTypes) : "N/A"}
- Common Tables: ${roleStats?.commonTables ? JSON.stringify(roleStats.commonTables) : "N/A"}
`;

  if (similarQueries.length > 0) {
    contextPrompt += `
SIMILAR SUCCESSFUL QUERIES FROM THIS ROLE (for reference):
`;
    similarQueries.forEach((q, i) => {
      contextPrompt += `
${i + 1}. User Question: "${q.nlQuestion}"
   Generated SQL: ${q.generatedSQL}
   Confidence: ${(q.similarity * 100).toFixed(1)}%
   Execution Time: ${q.executionTimeMs}ms
   Rows Returned: ${q.rowCount}
`;
    });

    contextPrompt += `
Use the above successful queries as reference patterns when appropriate.
`;
  }

  return contextPrompt;
}
