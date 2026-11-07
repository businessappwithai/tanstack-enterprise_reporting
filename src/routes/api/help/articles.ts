import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { getDb, waitForDatabaseReady } from "@/lib/db/kysely-db";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/help/articles")({
  server: {
    handlers: {
      GET: withApiHandler("/api/help/articles", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const url = new URL(request.url);
          const q = url.searchParams.get("q")?.toLowerCase() ?? "";

          const db = getDb();
          await waitForDatabaseReady();

          const articles = await db
            .selectFrom("help_articles")
            .selectAll()
            .where("is_published", "=", 1)
            .orderBy("sort_order", "asc")
            .execute();

          const filtered = q
            ? articles.filter(
                (a) =>
                  a.title.toLowerCase().includes(q) ||
                  a.keywords.toLowerCase().includes(q) ||
                  a.summary.toLowerCase().includes(q)
              )
            : articles;

          return json({ success: true, data: filtered });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch help articles");
        }
      }),
    },
  },
});
