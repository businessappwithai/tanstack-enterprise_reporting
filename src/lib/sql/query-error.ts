/**
 * What a failure running a person's own SQL against a data source means.
 *
 * The SQL editor runs whatever a signed-in user typed against a database that is
 * not ours, and the answer to "it failed" depends entirely on who is at fault:
 *
 *   - the query is wrong (a typo in a table name, a type mismatch): the database's
 *     message is what the person needs to fix it, so it is the caller's to read,
 *     and the failure is a `validation` one, logged as a warning;
 *   - the data source could not be reached, or took too long: that is an
 *     `integration` failure, an error for the operator, and the message — which
 *     can name a host — is not for the caller;
 *   - anything else is not understood, and is treated as an integration failure
 *     for the same reason.
 *
 * Pure, so it is tested with plain objects rather than a database.
 */

import { type AppError, appError } from "@/lib/errors/app-error";

interface DriverError {
  code?: unknown;
  errno?: unknown;
  number?: unknown;
  message?: unknown;
  name?: unknown;
}

const UNREACHABLE = ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"];
const TIMED_OUT = ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ETIMEOUT", "57014"];

export function toQueryError(error: unknown): AppError {
  const driver = (error && typeof error === "object" ? error : {}) as DriverError;
  const code = typeof driver.code === "string" ? driver.code : "";
  const message = typeof driver.message === "string" ? driver.message : "";

  if (TIMED_OUT.includes(code)) return appError("QUERY_TIMEOUT", { cause: error });
  if (UNREACHABLE.includes(code) || /^08/.test(code) || /^28/.test(code)) {
    return appError("DATABASE_CONNECTION_FAILED", { cause: error });
  }

  // PostgreSQL: class 42 is a syntax error or an access rule, 22 a bad value, 23 a
  // constraint. MySQL reports `ER_*`; SQL Server reports `EREQUEST` for a bad statement.
  const queryIsWrong =
    /^(42|22|23|0A)/.test(code) || code.startsWith("ER_") || code === "EREQUEST" || code === "ESOCKET_QUERY";
  if (queryIsWrong && message) {
    return appError("QUERY_FAILED", { message: message.slice(0, 500), cause: error });
  }

  return appError("INTEGRATION_FAILED", { cause: error });
}
