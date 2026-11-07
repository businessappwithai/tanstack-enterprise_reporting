import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";

async function getSession(_request: Request) {
  const { getAuthSession } = await import("@/lib/auth/config");
  return getAuthSession();
}

export const Route = createFileRoute("/api/charts/$id/filters")({
  server: {
    handlers: {
      GET: withApiHandler("/api/charts/$id/filters", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session) {
            return json({ error: "Unauthorized" }, { status: 401 });
          }

          // For now, return empty filters array
          // Charts can be extended with filter support later
          return json([]);
        } catch (error) {
          recordFailure(error, "Error fetching chart filters:");
          return json({ error: "Failed to fetch chart filters" }, { status: 500 });
        }
      }),
    },
  },
});
