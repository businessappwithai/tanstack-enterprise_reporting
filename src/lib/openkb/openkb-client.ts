/**
 * OpenKB Client: Redis-based knowledge base for role-scoped query learning (D20-D25)
 *
 * Stores successful NL→SQL translations + metadata for similarity search
 * Uses Redis with semantic vector embeddings for discovery
 */

import { createClient, type RedisClientType } from "redis";
import { EmbeddingService } from "./embedding-service";
import { getLogger } from "@/lib/logging/logger";

export interface OpenKBQuery {
  nlQuestion: string;
  generatedSQL: string;
  executionTimeMs: number;
  resultRowCount: number;
}

export interface OpenKBStoredQuery extends OpenKBQuery {
  queryId: string;
  timestamp: number;
  roleId: string;
}

export interface SimilarQuery extends OpenKBStoredQuery {
  similarity: number;
}

export class OpenKBClient {
  private redis: RedisClientType;
  private embeddingService: EmbeddingService;
  private isInitialized = false;

  constructor() {
    this.redis = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
    this.embeddingService = new EmbeddingService();
  }

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.redis.connect();
      this.isInitialized = true;
      getLogger("nlquery").event("nlquery.openkb.trace", { what: "Connected to Redis" });
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to connect to Redis", err: error });
      throw error;
    }
  }

  /**
   * Ensure initialized before operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Log a successful query to OpenKB (D20: auto-learn from all successful queries)
   */
  async logQuery(roleId: string, query: OpenKBQuery): Promise<string> {
    await this.ensureInitialized();

    const queryId = this.generateId();
    const timestamp = Date.now();

    try {
      // Store metadata in hash
      await this.redis.hSet(
        `openkb:${roleId}:metadata`,
        queryId,
        JSON.stringify({
          nlQuestion: query.nlQuestion,
          generatedSQL: query.generatedSQL,
          executionTimeMs: query.executionTimeMs,
          resultRowCount: query.resultRowCount,
          timestamp,
        })
      );

      // Add to time-indexed sorted set (for recent queries)
      await this.redis.zAdd(`openkb:${roleId}:queries`, { score: timestamp, value: queryId });

      // Generate embedding and store (D21: semantic embeddings)
      const embedding = await this.embeddingService.embed(query.nlQuestion);
      await this.redis.hSet(`openkb:${roleId}:embeddings`, queryId, JSON.stringify(embedding));

      getLogger("nlquery").event("nlquery.openkb.trace", { what: `Logged query ${queryId} for role ${roleId}` });
      return queryId;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to log query", err: error });
      throw error;
    }
  }

  /**
   * Find similar queries in OpenKB using semantic search (D21: semantic embeddings, D24: top 3 suggestions)
   */
  async findSimilar(roleId: string, query: string, topK: number = 3): Promise<SimilarQuery[]> {
    await this.ensureInitialized();

    try {
      // Embed the search query
      const queryEmbedding = await this.embeddingService.embed(query);

      // Get all embeddings for this role
      const storedEmbeddingsRaw = await this.redis.hGetAll(`openkb:${roleId}:embeddings`);

      if (Object.keys(storedEmbeddingsRaw).length === 0) {
        return []; // No queries in knowledge base yet
      }

      // Calculate similarities
      const similarities: Array<{ queryId: string; similarity: number }> = [];
      for (const [queryId, embeddingJson] of Object.entries(storedEmbeddingsRaw)) {
        try {
          const storedEmbedding = JSON.parse(embeddingJson as string);
          const similarity = this.cosineSimilarity(queryEmbedding, storedEmbedding);
          similarities.push({ queryId, similarity });
        } catch (_err) {
          getLogger("nlquery").event("nlquery.openkb.degraded", { what: `Failed to parse embedding for ${queryId}` });
        }
      }

      // Sort by similarity and get top K
      const topResults = similarities.sort((a, b) => b.similarity - a.similarity).slice(0, topK);

      // Fetch metadata for top results
      const results: SimilarQuery[] = [];
      for (const { queryId, similarity } of topResults) {
        const metadataJson = await this.redis.hGet(`openkb:${roleId}:metadata`, queryId);

        if (metadataJson) {
          try {
            const metadata = JSON.parse(metadataJson);
            results.push({
              queryId,
              ...metadata,
              roleId,
              similarity,
            });
          } catch (_err) {
            getLogger("nlquery").event("nlquery.openkb.degraded", { what: `Failed to parse metadata for ${queryId}` });
          }
        }
      }

      return results;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to find similar queries", err: error });
      return [];
    }
  }

  /**
   * Get recent queries for a role (discovery/browsing)
   */
  async getRecentQueries(roleId: string, limit: number = 20): Promise<OpenKBStoredQuery[]> {
    await this.ensureInitialized();

    try {
      // Get recent query IDs from sorted set (most recent first)
      const queryIds = await this.redis.zRange(`openkb:${roleId}:queries`, 0, limit - 1, {
        REV: true,
      });

      const results: OpenKBStoredQuery[] = [];
      for (const queryId of queryIds) {
        const metadataJson = await this.redis.hGet(`openkb:${roleId}:metadata`, queryId);

        if (metadataJson) {
          try {
            const metadata = JSON.parse(metadataJson);
            results.push({
              queryId,
              ...metadata,
              roleId,
            });
          } catch (_err) {
            getLogger("nlquery").event("nlquery.openkb.degraded", { what: `Failed to parse metadata for ${queryId}` });
          }
        }
      }

      return results;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to get recent queries", err: error });
      return [];
    }
  }

  /**
   * Delete a query from OpenKB (admin/curation)
   */
  async deleteQuery(roleId: string, queryId: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      await Promise.all([
        this.redis.hDel(`openkb:${roleId}:metadata`, queryId),
        this.redis.hDel(`openkb:${roleId}:embeddings`, queryId),
        this.redis.zRem(`openkb:${roleId}:queries`, queryId),
      ]);

      getLogger("nlquery").event("nlquery.openkb.trace", { what: `Deleted query ${queryId} from role ${roleId}` });
      return true;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to delete query", err: error });
      return false;
    }
  }

  /**
   * Clear all OpenKB data for a role (dangerous!)
   */
  async clearRole(roleId: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      await Promise.all([
        this.redis.del(`openkb:${roleId}:metadata`),
        this.redis.del(`openkb:${roleId}:embeddings`),
        this.redis.del(`openkb:${roleId}:queries`),
      ]);

      getLogger("nlquery").event("nlquery.openkb.trace", { what: `Cleared all data for role ${roleId}` });
      return true;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to clear role", err: error });
      return false;
    }
  }

  /**
   * Get statistics for a role's knowledge base
   */
  async getStats(roleId: string): Promise<{
    queryCount: number;
    oldestQuery?: number;
    newestQuery?: number;
  }> {
    await this.ensureInitialized();

    try {
      const queryCount = await this.redis.zCard(`openkb:${roleId}:queries`);

      const range = await this.redis.zRangeWithScores(`openkb:${roleId}:queries`, 0, -1);

      let oldestQuery: number | undefined;
      let newestQuery: number | undefined;

      if (range.length > 0) {
        oldestQuery = Math.min(...range.map((r) => (typeof r === "number" ? r : 0)));
        newestQuery = Math.max(...range.map((r) => (typeof r === "number" ? r : 0)));
      }

      return {
        queryCount,
        oldestQuery,
        newestQuery,
      };
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to get stats", err: error });
      return { queryCount: 0 };
    }
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.isInitialized) {
      await this.redis.quit();
      this.isInitialized = false;
    }
  }
}

// Singleton instance
let instance: OpenKBClient | null = null;

export async function getOpenKBClient(): Promise<OpenKBClient> {
  if (!instance) {
    instance = new OpenKBClient();
    await instance.initialize();
  }
  return instance;
}
