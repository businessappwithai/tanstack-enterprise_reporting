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

export const Route = createFileRoute("/api/jobs/executions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/jobs/executions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const db = getDb();
          const { searchParams } = new URL(request.url);
          const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);

          const executions = await db
            .selectFrom("job_executions")
            .selectAll()
            .orderBy("created_at", "desc")
            .limit(limit)
            .execute();

          return json({ success: true, data: { items: executions } });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch job executions");
        }
      }),
    },
  },
});
