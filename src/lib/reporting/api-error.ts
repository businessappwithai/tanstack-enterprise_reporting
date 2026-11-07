// What a refused or failed API call said, for a screen to show.
//
// The data routes answer a refusal with a status and { success: false, error: { code,
// message } } — 403 "You don't have permission to access: bus_household" when the caller's
// role may not read a table the query names. A viewer that returns `body.data` without
// asking `res.ok` turns that answer into `undefined`, and `undefined` renders as an empty
// table: "No results." A person who is not allowed to read the data is told there is none.

/** An error that remembers the HTTP status it came from. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Read the message out of a failed response; fall back to the status line. */
export async function readApiError(res: Response, fallback: string): Promise<ApiError> {
  let message = "";
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
    if (typeof body?.error === "string") {
      message = body.error;
    } else if (body?.error) {
      message = body.error.message ?? "";
      code = body.error.code;
    }
  } catch {
    // not JSON — the status line below is all there is
  }
  return new ApiError(message || `${fallback} (HTTP ${res.status})`, res.status, code);
}

/** Retry a transient failure, never a refusal: a 401/403/404 answers the same way twice. */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status !== undefined && status < 500) return false;
  return failureCount < 2;
}
