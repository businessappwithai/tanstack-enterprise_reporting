import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { json } from "@/lib/server/response";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/jobs/status")({
  server: {
    handlers: {
      GET: withApiHandler("/api/jobs/status", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const db = getDb();

          const countByStatus = await db
            .selectFrom("job_executions")
            .select(["status", db.fn.count("id").as("count")])
            .groupBy("status")
            .execute();

          const statusMap: Record<string, number> = {};
          for (const row of countByStatus) {
            statusMap[row.status] = Number(row.count);
          }

          return json({
            success: true,
            data: {
              waiting: statusMap.pending ?? 0,
              active: statusMap.running ?? 0,
              completed: statusMap.completed ?? 0,
              failed: statusMap.failed ?? 0,
              delayed: statusMap.cancelled ?? 0,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch job status");
        }
      }),
    },
  },
});
