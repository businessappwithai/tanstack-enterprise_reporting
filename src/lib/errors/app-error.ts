/**
 * The error this platform throws on purpose, and the one description of
 * anything that was thrown.
 *
 * `appError("QUERY_ACCESS_DENIED", { message })` names a code the catalogue
 * (`../logging/log-spec`) declares, and the catalogue says which category it
 * belongs to, which HTTP status it answers and what a caller is told when the
 * cause must not be described. Because `ErrorCode` is a union, a mistyped code
 * fails `bun check`.
 *
 * `ServerFunctionError` and its subclasses are the older interface and keep
 * their constructor: `new ServerFunctionError(message, code, statusCode)`. They
 * are classified the same way, by their code when the catalogue knows it and by
 * their status when it does not.
 *
 * Three rules shape `classify`:
 *   - A caller's mistake (4xx) keeps its message: the SQL editor tells a person
 *     which table they may not read, because only they can fix their query.
 *   - A server failure (5xx) never does. The caller gets the catalogue's fixed
 *     text and a reference; the cause goes to the log.
 *   - A constraint violation or a bad payload is the caller's problem; only a
 *     database that is down is the server's.
 */

import {
  ERROR_CATEGORIES,
  ERRORS,
  type ErrorCategory,
  type ErrorCode,
  type LogLevel,
} from "@/lib/logging/log-spec";

export class ServerFunctionError extends Error {
  constructor(
    message: string,
    public code: string = "INTERNAL_ERROR",
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ServerFunctionError";
  }
}

export interface AppErrorOptions {
  /** Written for a person; shown to the caller when the status is below 500. */
  message?: string;
  /**
   * The message was written by the author of this code, not taken from an exception, so it
   * is safe to show even at 500 ("Failed to fetch report"). Without it a 5xx shows the
   * catalogue's fixed text, because an unknown exception's message can be a driver's.
   */
  authored?: boolean;
  details?: Record<string, unknown>;
  /** What actually went wrong underneath. Logged, never sent. */
  cause?: unknown;
}

export class AppError extends ServerFunctionError {
  readonly category: ErrorCategory;
  readonly authored: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERRORS[code];
    super(options.message ?? definition.message, code, definition.status, options.details);
    this.name = "AppError";
    this.category = definition.category;
    this.authored = options.authored === true;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Build an `AppError`. Throw it: `throw appError("NOT_FOUND", { message: "Report not found" })`. */
export function appError(code: ErrorCode, options?: AppErrorOptions): AppError {
  return new AppError(code, options);
}

/**
 * What a route's `catch` throws: the error itself when it already says what it is, otherwise
 * a 500 carrying the route's own plain-language message and the real error as its cause.
 *
 *     } catch (error) {
 *       throw serverFailure(error, "Failed to fetch report");
 *     }
 *
 * The message is the route author's and is shown; the cause is logged with its stack and never
 * sent. This replaces `message: error.message` and hand-built 500 bodies.
 */
export function serverFailure(error: unknown, message: string): ServerFunctionError {
  if (error instanceof ServerFunctionError) return error;
  return appError("SERVER_ERROR", { message, cause: error, authored: true });
}

/** The category a bare HTTP status falls in: the first declared that allows it. */
export function categoryForStatus(status: number): ErrorCategory {
  for (const name of Object.keys(ERROR_CATEGORIES) as ErrorCategory[]) {
    if ((ERROR_CATEGORIES[name].statuses as readonly number[]).includes(status)) return name;
  }
  return status >= 500 ? "internal" : "validation";
}

/** The code used when an exception names none: one per category. */
export const FALLBACK_CODE: Record<ErrorCategory, ErrorCode> = {
  validation: "INVALID_INPUT",
  authentication: "UNAUTHORIZED",
  authorization: "FORBIDDEN",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  business_rule: "VALIDATION_ERROR",
  workflow: "VALIDATION_ERROR",
  rate_limit: "RATE_LIMITED",
  integration: "INTEGRATION_FAILED",
  database: "DATABASE_ERROR",
  configuration: "NOT_CONFIGURED",
  internal: "SERVER_ERROR",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERRORS, value);
}

export interface Classified {
  status: number;
  category: ErrorCategory;
  code: string;
  /** What the caller is told. */
  message: string;
  details?: Record<string, unknown>;
  /** The level the request is logged at: the category's own. */
  level: LogLevel;
}

function levelOf(category: ErrorCategory): LogLevel {
  return ERROR_CATEGORIES[category].level;
}

function fixed(code: ErrorCode, status?: number, message?: string): Classified {
  const definition = ERRORS[code];
  return {
    status: status ?? definition.status,
    category: definition.category,
    code,
    message: message ?? definition.message,
    level: levelOf(definition.category),
  };
}

/** Socket errors Node reports before a database gets a word in. */
const UNREACHABLE = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"];

export function classify(exception: unknown): Classified {
  if (exception instanceof ServerFunctionError) {
    const known = isErrorCode(exception.code);
    const category = known
      ? (ERRORS[exception.code as ErrorCode].category as ErrorCategory)
      : categoryForStatus(exception.statusCode);
    const status = exception.statusCode;
    const code = known ? exception.code : FALLBACK_CODE[category];
    if (status >= 500) {
      const authored = exception instanceof AppError && exception.authored;
      return {
        ...fixed(code as ErrorCode, status, authored ? exception.message : undefined),
        code: exception.code,
      };
    }
    return {
      status,
      category,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      level: levelOf(category),
    };
  }

  if (exception instanceof Error) {
    // The session lookup failed: a restarting database must not read as "signed out".
    if (exception.name === "SessionUnavailableError") return fixed("SESSION_UNAVAILABLE");

    // A body that is not JSON.
    if (exception instanceof SyntaxError) {
      return fixed("INVALID_INPUT", 400, "The request body is not valid JSON.");
    }

    // Zod: say which fields, never the values that were refused.
    if (exception.name === "ZodError") {
      const issues = (exception as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues ?? [];
      return {
        ...fixed("VALIDATION_ERROR"),
        details: { issues: issues.slice(0, 20).map((i) => ({ path: (i.path ?? []).join("."), message: i.message })) },
      };
    }

    const driver = exception as { code?: unknown };
    const code = typeof driver.code === "string" ? driver.code : "";
    if (code === "23505") return fixed("CONFLICT", 409, "A record with the same value already exists.");
    if (/^(23|22)/.test(code)) return fixed("INVALID_INPUT", 400, "A value was not valid for its column.");
    if (/^(08|53|57P0)/.test(code) || UNREACHABLE.includes(code)) return fixed("DATABASE_UNAVAILABLE");
    if (/^[0-9A-Z]{5}$/.test(code)) return fixed("DATABASE_ERROR");
  }

  return fixed("SERVER_ERROR");
}
