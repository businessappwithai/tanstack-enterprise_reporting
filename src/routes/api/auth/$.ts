/**
 * Better Auth's own HTTP surface — sign-in, sign-out, session, and everything
 * else the library routes itself.
 *
 * `basePath` in src/lib/auth/better-auth.ts is `/api/auth`, so this splat has
 * to live at exactly that path or the library's generated URLs point at a 404.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth/better-auth";
import { withApiHandler } from "@/lib/http/with-api-handler";

// Wrapped so sign-in, sign-out and session calls get the same request line, request id and
// failure envelope as every other route.
const handler = withApiHandler("/api/auth/$", ({ request }: { request: Request }) =>
  getAuth().handler(request)
);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
