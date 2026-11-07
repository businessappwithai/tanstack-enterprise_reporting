/**
 * Who sees which rows of the System Logs table.
 *
 * The table holds three kinds of row, and they are not equally private:
 *
 *   - **a person's own** — what happened on a request they made. Theirs, in full.
 *   - **the system's** — a warning or an error with no person attached: a job that failed, a
 *     pool that dropped a connection. Everyone who may open System Logs has a reason to see
 *     that something is wrong, but not the stack trace or the fields, which describe the
 *     platform's insides.
 *   - **someone else's** — visible to an administrator, and to anyone who holds the *reference*
 *     of that request. The reference is the id an error showed them and it cannot be guessed,
 *     so a person who quotes it may be shown what became of that request, in the same
 *     reduced form as a system row.
 *
 * Before this, an ordinary user saw their own rows and nothing else, and an administrator
 * saw only their own too unless they picked a user. Both were too narrow to answer "something
 * is failing" or "what happened to this reference".
 *
 * The decisions live here, free of the database, so they are tested with plain values; the
 * route turns `scopeFor` into a WHERE clause.
 */

export interface Viewer {
  id: string;
  isAdmin: boolean;
}

export interface LogFilters {
  userId?: string | null;
  requestId?: string | null;
}

/**
 * What counts as the system having a problem: any error, and any warning that is not just a
 * request somebody else made and was refused (the `http` channel's 4xx lines are other people's
 * mistakes, not the platform's).
 */
export const SYSTEM_ERROR_LEVEL = "error";
export const SYSTEM_WARNING_LEVEL = "warn";
export const SYSTEM_QUIET_COMPONENT = "http";

export type RowScope =
  | { kind: "everyone" }
  | { kind: "user"; userId: string }
  | { kind: "own-and-system"; viewerId: string; requestId?: string };

export function scopeFor(viewer: Viewer, filters: LogFilters = {}): RowScope {
  if (viewer.isAdmin) {
    return filters.userId ? { kind: "user", userId: filters.userId } : { kind: "everyone" };
  }
  const requestId = filters.requestId?.slice(0, 64) || undefined;
  return { kind: "own-and-system", viewerId: viewer.id, ...(requestId && { requestId }) };
}

/** The fields only the owner (or an administrator) may read. */
const PRIVATE_FIELDS = ["error_stack", "metadata", "session_id", "message_vector"] as const;

export interface ViewableRow {
  user_id?: string | null;
  error_stack?: unknown;
  metadata?: unknown;
  session_id?: unknown;
  message_vector?: unknown;
  [key: string]: unknown;
}

/** Whether this viewer may read the row whole. */
export function mayReadWhole(viewer: Viewer, row: ViewableRow): boolean {
  return viewer.isAdmin || (Boolean(row.user_id) && row.user_id === viewer.id);
}

/**
 * The row as this viewer may see it. A row they may not read whole loses its stack, its fields
 * and its session, and does not say whose it is: "system" for a row with no person, "another
 * user" for a row found by its reference.
 */
export function shapeForViewer<T extends ViewableRow>(viewer: Viewer, row: T): T & { visibility: "full" | "limited" } {
  if (mayReadWhole(viewer, row)) return { ...row, visibility: "full" };
  const limited: Record<string, unknown> = { ...row };
  for (const field of PRIVATE_FIELDS) limited[field] = null;
  limited.user_id = null;
  limited.user_email = row.user_id == null ? "system" : "another user";
  limited.visibility = "limited";
  return limited as T & { visibility: "limited" };
}

/**
 * Narrow a query on `logs` to what the scope allows. Kept loose on the builder's type: the
 * same function serves the list and the search, which select different columns.
 */
export function applyScope<Q>(query: Q, scope: RowScope): Q {
  if (scope.kind === "everyone") return query;
  // Typed loosely on purpose: the same function serves the list and the search, which select
  // different columns, and Kysely's builder generics cannot say "any select on logs".
  const builder = query as unknown as {
    where: (...args: unknown[]) => unknown;
  };
  if (scope.kind === "user") return builder.where("user_id", "=", scope.userId) as Q;
  return builder.where((eb: any) =>
    eb.or([
      eb("user_id", "=", scope.viewerId),
      eb.and([
        eb("user_id", "is", null),
        eb.or([
          eb("level", "=", SYSTEM_ERROR_LEVEL),
          eb.and([eb("level", "=", SYSTEM_WARNING_LEVEL), eb("component", "!=", SYSTEM_QUIET_COMPONENT)]),
        ]),
      ]),
      ...(scope.requestId ? [eb("request_id", "=", scope.requestId)] : []),
    ])
  ) as Q;
}
