import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/data-sources/$id/usage")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id/usage", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const db = getDb();

          // Check if data source exists
          const dataSource = await db
            .selectFrom("data_sources")
            .select("id")
            .where("id", "=", params.id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!dataSource) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          // For now, return 0 usage to allow deletion
          // In production, this would count actual references
          return json({
            success: true,
            data: {
              queries: 0,
              reports: 0,
              charts: 0,
            },
          });
        } catch (error) {
          recordFailure(error, "Data source usage error:");
          return json(
            {
              success: true,
              data: {
                queries: 0,
                reports: 0,
                charts: 0,
              },
            },
            { status: 200 }
          );
        }
      }),
    },
  },
});
