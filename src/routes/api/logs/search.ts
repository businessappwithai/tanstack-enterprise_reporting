import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { json } from "@/lib/server/response";
import {
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { generateLogEmbedding } from "@/lib/embeddings/vector-embeddings";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/logs/search")({
  server: {
    handlers: {
      POST: withApiHandler("/api/logs/search", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "log", "view");
          if (denied) return denied;

          const body = (await request.json()) as {
            query: string;
            limit?: number;
            threshold?: number;
          };

          if (!body.query) {
            return json(
              { success: false, error: { code: "INVALID_INPUT", message: "Query is required" } },
              { status: 400 }
            );
          }

          const db = getDb();
          const limit = Math.min(body.limit || 10, 100);
          const threshold = body.threshold || 0.5;

          // Generate embedding for search query
          const queryVector = generateLogEmbedding(body.query, "search", "info");

          // Get all logs and calculate similarity on the client side
          // (MariaDB doesn't have native vector similarity functions)
          const allLogs = await db
            .selectFrom("logs")
            .select([
              "id",
              "timestamp",
              "level",
              "message",
              "component",
              "user_id",
              "session_id",
              "metadata",
              "error_stack",
              "request_id",
              "message_vector",
            ])
            .where("user_id", "=", session.user.id as any)
            .execute();

          // Import cosine similarity function
          const { cosineSimilarity } = await import("@/lib/embeddings/vector-embeddings");

          // Calculate similarity scores and filter
          const resultsWithScores = allLogs
            .map((log) => {
              let similarity = 0;
              if (log.message_vector) {
                try {
                  const logVector = JSON.parse(log.message_vector);
                  similarity = cosineSimilarity(queryVector, logVector);
                } catch (e) {
                  similarity = 0;
                }
              }
              return {
                ...log,
                similarity,
              };
            })
            .filter((item) => item.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);

          return json({
            success: true,
            data: {
              query: body.query,
              results: resultsWithScores.map((log) => ({
                id: log.id,
                timestamp: log.timestamp,
                level: log.level,
                message: log.message,
                component: log.component,
                user_id: log.user_id,
                similarity: log.similarity,
              })),
              total: resultsWithScores.length,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),
    },
  },
});
