import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      GET: withApiHandler("/api/notifications", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          // Notifications table not yet migrated — return empty array (header expects array)
          return json({ success: true, data: [] });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch notifications");
        }
      }),
    },
  },
});
