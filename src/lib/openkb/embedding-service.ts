/**
 * Embedding Service: Generate vector embeddings via llama.cpp (D23)
 *
 * Uses llama.cpp's OpenAI-compatible /v1/embeddings endpoint.
 */

import { createReasoningClient } from "@/lib/voice/llama-client";
import { isLlamaReasoningAvailable } from "@/lib/voice/llama-client";
import { getLogger } from "@/lib/logging/logger";

export class EmbeddingService {
  private model: string;
  private cache: Map<string, number[]> = new Map();

  constructor() {
    this.model = process.env.LLAMA_EMBEDDING_MODEL || "bge-small";
  }

  /**
   * Generate embedding for text via llama.cpp /v1/embeddings
   */
  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const cacheKey = this.getCacheKey(text);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as number[];
    }

    try {
      const client = createReasoningClient();
      const response = await client.embeddings.create({
        model: this.model,
        input: text,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding || embedding.length === 0) {
        getLogger("nlquery").event("nlquery.openkb.degraded", { what: "No embedding returned from llama.cpp" });
        return [];
      }

      this.cache.set(cacheKey, embedding);

      if (this.cache.size > 1000) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }

      return embedding;
    } catch (error) {
      getLogger("nlquery").event("nlquery.openkb.failed", { what: "Failed to generate embedding", err: error });
      return [];
    }
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async isAvailable(): Promise<boolean> {
    return isLlamaReasoningAvailable();
  }

  async isModelLoaded(): Promise<boolean> {
    return isLlamaReasoningAvailable();
  }

  private getCacheKey(text: string): string {
    if (text.length < 200) return text;
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `hash_${Math.abs(hash)}`;
  }
}
