import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { closeDb, waitForDatabaseReady } from "@/lib/db/config";
import { initializeWorkers, shutdownWorkers } from "@/lib/jobs/worker-runner";
import { initGraph } from "@/lib/graph/graph-init";
import { syncKnowledgeGraph } from "@/lib/graph/sync";
import { getLogger } from "@/lib/logging/logger";

// Persistent config store will be imported and initialized on first use

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' ws: wss: http://localhost:4050 http://localhost:8080 http://localhost:8081 http://localhost:8083 http://localhost:4111 https://api.cloud.copilotkit.ai https://cdn.copilotkit.ai https://telemetry.copilotkit.ai; worker-src 'self' blob:; frame-ancestors 'none';",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
};

// With CHAT_EMBED=1 the chat assistant, served from this same origin, shows this
// platform's pages in a frame. Framing stays same-origin only; without the flag
// nothing may frame the platform at all, as before.
if (process.env.CHAT_EMBED === "1") {
  SECURITY_HEADERS["Content-Security-Policy"] = (SECURITY_HEADERS["Content-Security-Policy"] ?? "").replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'"
  );
  SECURITY_HEADERS["X-Frame-Options"] = "SAMEORIGIN";
}

const handler = createStartHandler(defaultStreamHandler);

// Start background workers (Trigger.dev or on-premise cron runner)
initializeWorkers().catch((err) => getLogger("app").event("app.startup.failed", { what: "Worker init failed (non-fatal)", err: err }));

// Bootstrap Apache AGE knowledge graph, then sync schema + config metadata
initGraph()
  .then(() => syncKnowledgeGraph())
  .catch((err) => getLogger("app").event("app.startup.degraded", { what: "Knowledge graph init failed (non-fatal)", err: err }));

const fetch: RequestHandler<Register> = async (request, opts) => {
  await waitForDatabaseReady();

  // Chat-only mode: outside the assistant's frame, a non-administrator is sent to the chat.
  const { chatOnlyRedirect } = await import("@/lib/chat/chat-only");
  const toChat = await chatOnlyRedirect(request);
  if (toChat) {
    return new Response(null, { status: 302, headers: { Location: toChat, "Cache-Control": "no-store" } });
  }

  const response = await handler(request, opts);

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

// Graceful shutdown for proper database cleanup
if (typeof process !== "undefined" && process.versions?.node) {
  const shutdown = async () => {
    await shutdownWorkers();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export default { fetch };
