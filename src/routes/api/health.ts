import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: withApiHandler("/api/health", async () => {
        return json({ status: "ok", timestamp: new Date().toISOString() });
      }),
    },
  },
});
