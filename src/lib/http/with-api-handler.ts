/**
 * One wrapper for an API route's handlers, so every route logs and answers a
 * failure the same way.
 *
 *     POST: withApiHandler("/api/sql/execute", async ({ request }) => { … })
 *
 * What it does, once, for every route it wraps:
 *   - opens a request context (the request id and, once known, the user) so
 *     every log line written during the request carries them;
 *   - writes the single `http.request.*` line, at the level of what happened:
 *     a missing record or a stale save is info, a refusal or a bad payload
 *     warn, a server failure error;
 *   - turns anything the handler throws into the platform's error envelope,
 *     `{ success: false, error: { code, category, message, ref } }`, with the
 *     cause hidden on a 5xx;
 *   - echoes the request id as `x-request-id`, and in the body as `ref`, so a
 *     person reporting a failure can quote the line to find.
 *
 * A handler may keep returning its own error responses; they are logged by
 * status. A handler that wants the standard answer throws `appError(code)`.
 * The request body is never read here, so the "read it twice in the catch"
 * mistake cannot recur.
 */

import { classify, categoryForStatus } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/logger";
import { ERROR_CATEGORIES } from "@/lib/logging/log-spec";
import { acceptRequestId, runWithRequestContext } from "@/lib/logging/request-context";
import { json } from "@/lib/server/response";

const SLOW_MS = Number(process.env.HTTP_SLOW_REQUEST_MS ?? 5000);

type Handler<C extends { request: Request }> = (context: C) => Promise<Response> | Response;

/** The code a handler's own error response carries, read without consuming it. */
async function codeOf(response: Response): Promise<string | null> {
  try {
    if (!response.headers.get("content-type")?.includes("application/json")) return null;
    const body = (await response.clone().json()) as { error?: { code?: unknown } | string; code?: unknown };
    const code = typeof body.error === "object" ? body.error?.code : (body.code ?? body.error);
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set("x-request-id", requestId);
    return response;
  } catch {
    // Immutable headers (a response built by fetch): copy it.
    const copy = new Response(response.body, response);
    copy.headers.set("x-request-id", requestId);
    return copy;
  }
}

export function withApiHandler<C extends { request: Request }>(
  route: string,
  handler: Handler<C>
): (context: C) => Promise<Response> {
  return async (context) => {
    const { request } = context;
    const requestId = acceptRequestId(request.headers.get("x-request-id"));
    const startedAt = Date.now();
    const log = getLogger("http");
    const base = { method: request.method, path: route, requestId };

    return runWithRequestContext({ requestId, route, userId: null }, async () => {
      let response: Response;
      let thrown: unknown;

      try {
        response = await handler(context);
      } catch (error) {
        thrown = error;
        const classified = classify(error);
        response = json(
          {
            success: false,
            error: {
              code: classified.code,
              category: classified.category,
              message: classified.message,
              ref: requestId,
              ...(classified.details && { details: classified.details }),
            },
          },
          { status: classified.status }
        );
      }

      const status = response.status;
      const durationMs = Date.now() - startedAt;

      if (status >= 400) {
        const category = thrown ? classify(thrown).category : categoryForStatus(status);
        const errorCode = thrown ? classify(thrown).code : await codeOf(response);
        const fields = { ...base, status, durationMs, errorCategory: category, errorCode };
        if (status >= 500) {
          log.event("http.request.failed", { ...fields, err: thrown ?? null });
        } else if (ERROR_CATEGORIES[category].level === "info") {
          log.event("http.request.refused", fields);
        } else {
          log.event("http.request.client_error", fields);
        }
      } else {
        log.event("http.request.completed", { ...base, status, durationMs });
      }

      if (durationMs > SLOW_MS) {
        log.event("http.request.slow", { ...base, durationMs, budgetMs: SLOW_MS });
      }

      return withRequestId(response, requestId);
    });
  };
}
