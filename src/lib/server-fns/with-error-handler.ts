import { classify, ServerFunctionError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/logger";
import { currentRequestContext } from "@/lib/logging/request-context";
import { logAudit } from "@/lib/security/audit";
import type { SessionUser } from "@/lib/auth/session";
import type { ResourceType } from "@/types/database";

export { ServerFunctionError };

export interface ErrorContext {
  /**
   * The acting user. Callers that only have the id may pass `userId` instead —
   * most do, which is why both are accepted and `resolveUserId` reads either.
   */
  user?: SessionUser;
  userId?: string;
  action: string;
  /**
   * Optional: many call sites describe the action but have no single resource
   * to name, and audit rows for those are still worth writing.
   */
  resourceType?: ResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
}

/** The acting user's id, from whichever of the two fields the caller supplied. */
function resolveUserId(context: ErrorContext): string | undefined {
  return context.userId ?? context.user?.id;
}

export class ValidationError extends ServerFunctionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 422, details);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends ServerFunctionError {
  constructor(message: string = "Not authorized") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends ServerFunctionError {
  constructor(resourceType: string, resourceId?: string) {
    const msg = resourceId
      ? `${resourceType} not found: ${resourceId}`
      : `${resourceType} not found`;
    super(msg, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export async function withErrorHandler<T>(
  handler: () => Promise<T>,
  context: ErrorContext
): Promise<T> {
  try {
    return await handler();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const classified = classify(error);
    const actingUserId = resolveUserId(context);
    const requestId = currentRequestContext()?.requestId;

    // The same line an API route writes, so a failed server function and a failed
    // route read alike in the log: by category, with the cause on a 5xx only.
    const log = getLogger("http");
    const fields = {
      method: "RPC",
      path: context.action,
      status: classified.status,
      durationMs: null,
      requestId: requestId ?? null,
      errorCategory: classified.category,
      errorCode: classified.code,
    };
    if (classified.status >= 500) log.event("http.request.failed", { ...fields, err: error });
    else if (classified.level === "info") log.event("http.request.refused", fields);
    else log.event("http.request.client_error", fields);

    // Audit trail for all errors
    if (actingUserId) {
      await logAudit({
        userId: actingUserId,
        action: "execute",
        resourceType: context.resourceType ?? "setting",
        resourceId: context.resourceId,
        details: {
          // The audit row is for administrators, who may read the cause.
          error: error instanceof ServerFunctionError ? error.message : error.message.substring(0, 200),
          code: classified.code,
          category: classified.category,
          action: context.action,
          ...context.details,
        },
      }).catch((auditError) => {
        getLogger("http").event("http.request.failed", {
          ...fields,
          path: "audit",
          err: auditError,
        });
      });
    }

    // A caller's mistake keeps its message; a server failure is the catalogue's fixed
    // text, with the request id to quote. It used to send `error.message` to any
    // signed-in user, which is a database or driver message.
    if (error instanceof ServerFunctionError && classified.status < 500) throw error;
    const failure = new ServerFunctionError(
      requestId ? `${classified.message} (Reference: ${requestId})` : classified.message,
      classified.code,
      classified.status
    );
    (failure as { cause?: unknown }).cause = error;
    throw failure;
  }
}
