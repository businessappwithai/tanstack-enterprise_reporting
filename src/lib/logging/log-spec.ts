/**
 * What this platform logs, and what each failure is worth — stated once.
 *
 * The same shape as the generated application's `log-spec.json` in
 * `app-with-ai-tanstack` (levels, redaction, channels, events, error categories
 * and codes), so an operator reading logs from both products reads one
 * vocabulary. It is TypeScript rather than JSON here only so that `ErrorCode`
 * and `EventId` are unions the compiler checks: `appError("TYPO")` and
 * `.event("sql.typo")` fail `bun check` instead of degrading to a warning at
 * run time.
 *
 * A call site names an event; the level, the channel and the message come from
 * here. Never write a level and a sentence at a call site.
 */

export const LEVELS = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } as const;
export type LogLevel = keyof typeof LEVELS;
export type ConfiguredLevel = LogLevel | "silent";

export const ENVIRONMENTS: Record<string, { level: ConfiguredLevel; pretty: boolean }> = {
  production: { level: "info", pretty: false },
  staging: { level: "info", pretty: false },
  development: { level: "debug", pretty: true },
  test: { level: "silent", pretty: false },
};

/** Keys whose values never reach a log, by name, at any depth. */
export const REDACT_KEYS = [
  "password",
  "passwordHash",
  "password_hash",
  "currentPassword",
  "newPassword",
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "apiKey",
  "api_key",
  "secret",
  "clientSecret",
  "privateKey",
  "authorization",
  "cookie",
  "setCookie",
  // Specific to this platform: a data source's stored connection and anything
  // that is key material for it.
  "connection_config",
  "connectionConfig",
  "connectionString",
  "ENCRYPTION_KEY",
  "AUTH_SECRET",
  "sql_params",
] as const;

export const REDACT_CENSOR = "[redacted]";

/* -------------------------------------------------------------------------- */
/*  Error categories — identical in every product                              */
/* -------------------------------------------------------------------------- */

export type ErrorExposure = "message" | "code" | "generic";

export const ERROR_CATEGORIES = {
  validation: { statuses: [400, 422], level: "warn", expose: "message" },
  authentication: { statuses: [401], level: "warn", expose: "generic" },
  authorization: { statuses: [403], level: "warn", expose: "code" },
  not_found: { statuses: [404], level: "info", expose: "message" },
  conflict: { statuses: [409, 428], level: "info", expose: "message" },
  business_rule: { statuses: [422], level: "info", expose: "message" },
  workflow: { statuses: [409, 422], level: "warn", expose: "message" },
  rate_limit: { statuses: [429], level: "warn", expose: "message" },
  integration: { statuses: [502, 503, 504], level: "error", expose: "generic" },
  database: { statuses: [500, 503], level: "error", expose: "generic" },
  configuration: { statuses: [500], level: "error", expose: "generic" },
  internal: { statuses: [500], level: "error", expose: "generic" },
} as const satisfies Record<
  string,
  { statuses: readonly number[]; level: LogLevel; expose: ErrorExposure }
>;

export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

/* -------------------------------------------------------------------------- */
/*  Error codes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The codes the API answers with. The first group keeps the names the routes
 * and the front end already use (`UNAUTHORIZED`, `NOT_FOUND`, `SERVER_ERROR`,
 * …): renaming one is a breaking change to the API, not a tidy-up.
 */
export const ERRORS = {
  // validation
  INVALID_INPUT: { category: "validation", status: 400, message: "The request data is not valid." },
  VALIDATION_ERROR: { category: "validation", status: 422, message: "The request data is not valid." },
  INVALID_FORMAT: { category: "validation", status: 400, message: "That format is not supported." },
  INVALID_ACTION: { category: "validation", status: 400, message: "That action is not supported." },
  NO_QUERY: { category: "validation", status: 400, message: "There is no query to run." },
  SQL_REQUIRED: { category: "validation", status: 400, message: "A SQL statement is required." },
  SQL_SYNTAX_ERROR: { category: "validation", status: 400, message: "The SQL could not be parsed." },
  QUERY_NOT_READ_ONLY: {
    category: "validation",
    status: 400,
    message: "Only a single read-only statement may be run.",
  },
  QUERY_FAILED: { category: "validation", status: 400, message: "The query could not be run." },
  INVALID_DATA_SOURCE_CONFIG: {
    category: "validation",
    status: 400,
    message: "The data source settings are not valid.",
  },
  DATASET_TOO_LARGE: {
    category: "validation",
    status: 422,
    message: "The result is too large to download.",
  },
  // authentication
  UNAUTHORIZED: { category: "authentication", status: 401, message: "Sign in to continue." },
  AUTHENTICATION_FAILED: { category: "authentication", status: 401, message: "Sign in to continue." },
  // authorization
  FORBIDDEN: { category: "authorization", status: 403, message: "You do not have permission to do this." },
  INSUFFICIENT_PERMISSIONS: {
    category: "authorization",
    status: 403,
    message: "You do not have permission to do this.",
  },
  QUERY_ACCESS_DENIED: {
    category: "authorization",
    status: 403,
    message: "You do not have access to a table this query reads.",
  },
  // not_found
  NOT_FOUND: { category: "not_found", status: 404, message: "Not found." },
  QUERY_NOT_FOUND: { category: "not_found", status: 404, message: "That query does not exist." },
  DATASOURCE_NOT_FOUND: { category: "not_found", status: 404, message: "That data source does not exist." },
  DATABASE_NOT_FOUND: { category: "not_found", status: 404, message: "That database does not exist." },
  // conflict
  CONFLICT: { category: "conflict", status: 409, message: "The request conflicts with the current state." },
  // rate_limit
  RATE_LIMITED: { category: "rate_limit", status: 429, message: "Too many requests. Try again shortly." },
  // integration
  INTEGRATION_FAILED: { category: "integration", status: 502, message: "A service this platform depends on failed." },
  DATABASE_CONNECTION_FAILED: {
    category: "integration",
    status: 502,
    message: "The data source could not be reached.",
  },
  SCHEMA_LOAD_FAILED: { category: "integration", status: 502, message: "The data source's schema could not be read." },
  INTROSPECTION_ERROR: { category: "integration", status: 502, message: "The data source's schema could not be read." },
  DATA_SOURCE_UNAVAILABLE: { category: "integration", status: 503, message: "The data source is unavailable." },
  CONNECTION_POOL_FULL: { category: "integration", status: 503, message: "The data source is busy. Try again shortly." },
  AI_UNAVAILABLE: { category: "integration", status: 503, message: "The assistant is unavailable." },
  QUERY_TIMEOUT: { category: "integration", status: 504, message: "The data source did not answer in time." },
  // database
  SESSION_UNAVAILABLE: {
    category: "database",
    status: 503,
    message: "Your sign-in could not be checked. Try again.",
  },
  DATABASE_UNAVAILABLE: { category: "database", status: 503, message: "The database is unavailable. Try again shortly." },
  DATABASE_ERROR: { category: "database", status: 500, message: "Something went wrong. Quote the reference if you ask for help." },
  // configuration
  NOT_CONFIGURED: { category: "configuration", status: 500, message: "This feature is not configured." },
  // internal
  SERVER_ERROR: { category: "internal", status: 500, message: "Something went wrong. Quote the reference if you ask for help." },
  INTERNAL_ERROR: { category: "internal", status: 500, message: "Something went wrong. Quote the reference if you ask for help." },
  EXECUTION_ERROR: { category: "internal", status: 500, message: "Something went wrong. Quote the reference if you ask for help." },
  FILE_EXPORT_FAILED: { category: "internal", status: 500, message: "The file could not be produced." },
} as const satisfies Record<string, { category: ErrorCategory; status: number; message: string }>;

export type ErrorCode = keyof typeof ERRORS;

/* -------------------------------------------------------------------------- */
/*  Channels and events                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A channel declares the most verbose level it can be turned up to. The environment clamps it:
 * production logs at info whatever a channel declares, development shows debug. Every channel
 * carries `debug` events (and free-text notes), so each is declared at debug.
 */
export const CHANNELS = {
  app: "debug",
  http: "debug",
  auth: "debug",
  db: "debug",
  sql: "debug",
  datasource: "debug",
  nlquery: "debug",
  jobs: "debug",
  report: "debug",
  email: "debug",
  graph: "debug",
  voice: "debug",
  client: "debug",
  audit: "debug",
  logging: "warn",
} as const satisfies Record<string, LogLevel>;

export type Channel = keyof typeof CHANNELS;

interface EventDef {
  channel: Channel;
  level: LogLevel;
  message: string;
  fields: readonly string[];
}

export const EVENTS = {
  // The old free-text interface, kept in the spec so a line written through `note()` still has
  // a level an operator controls. A call that matters should get an event of its own.
  "note.debug": { channel: "app", level: "debug", message: "Note", fields: ["what"] },
  "note.info": { channel: "app", level: "info", message: "Note", fields: ["what"] },
  "note.warn": { channel: "app", level: "warn", message: "Warning", fields: ["what"] },
  "note.error": { channel: "app", level: "error", message: "Failure", fields: ["what"] },
  "app.uncaught": { channel: "app", level: "fatal", message: "Uncaught exception", fields: ["err"] },
  "app.unhandled_rejection": { channel: "app", level: "error", message: "Unhandled promise rejection", fields: ["err"] },
  "app.shutdown": { channel: "app", level: "info", message: "Shutting down", fields: ["signal", "uptimeMs"] },
  "http.request.completed": {
    channel: "http",
    level: "info",
    message: "Request completed",
    fields: ["method", "path", "status", "durationMs", "requestId"],
  },
  "http.request.refused": {
    channel: "http",
    level: "info",
    message: "Request refused",
    fields: ["method", "path", "status", "durationMs", "requestId", "errorCategory", "errorCode"],
  },
  "http.request.client_error": {
    channel: "http",
    level: "warn",
    message: "Request rejected",
    fields: ["method", "path", "status", "durationMs", "requestId", "errorCategory", "errorCode"],
  },
  "http.request.failed": {
    channel: "http",
    level: "error",
    message: "Request failed",
    fields: ["method", "path", "status", "durationMs", "requestId", "errorCategory", "errorCode", "err"],
  },
  "http.request.slow": {
    channel: "http",
    level: "warn",
    message: "Slow request",
    fields: ["method", "path", "durationMs", "budgetMs", "requestId"],
  },
  "auth.session.unavailable": {
    channel: "auth",
    level: "error",
    message: "Session could not be checked",
    fields: ["err"],
  },
  "db.pool.error": { channel: "db", level: "warn", message: "Idle database connection lost", fields: ["pool", "err"] },
  "sql.query.executed": {
    channel: "sql",
    level: "info",
    message: "Query executed",
    fields: ["dataSourceId", "rowCount", "durationMs", "userId"],
  },
  "sql.query.refused": {
    channel: "sql",
    level: "warn",
    message: "Query refused",
    fields: ["dataSourceId", "reason", "userId"],
  },
  "sql.query.failed": {
    channel: "sql",
    level: "warn",
    message: "Query failed",
    fields: ["dataSourceId", "errorCode", "durationMs", "sqlChars", "userId"],
  },
  "audit.write.failed": { channel: "audit", level: "warn", message: "Audit entry could not be written", fields: ["resource", "err"] },
  "datasource.test.completed": {
    channel: "datasource",
    level: "info",
    message: "Connection test completed",
    fields: ["clientType", "connected", "durationMs"],
  },
  "datasource.test.refused": { channel: "datasource", level: "warn", message: "Connection test refused", fields: ["reason"] },
  "datasource.test.failed": {
    channel: "datasource",
    level: "warn",
    message: "Connection test failed",
    fields: ["errorCode", "durationMs"],
  },
  "datasource.inspect.failed": {
    channel: "datasource",
    level: "warn",
    message: "Schema inspection failed",
    fields: ["errorCode"],
  },
  "voice.connection.opened": { channel: "voice", level: "info", message: "Voice connection opened", fields: [] },
  "voice.connection.closed": { channel: "voice", level: "info", message: "Voice connection closed", fields: [] },
  "voice.socket.error": { channel: "voice", level: "warn", message: "Voice socket error", fields: ["err"] },
  "voice.transcription.failed": { channel: "voice", level: "warn", message: "Transcription failed", fields: ["reason"] },
  "nlquery.embedding.store_failed": {
    channel: "nlquery",
    level: "warn",
    message: "Embedding could not be stored",
    fields: ["target", "err"],
  },
  "jobs.schedule.failed": { channel: "jobs", level: "warn", message: "Schedule could not be created", fields: ["target", "err"] },
  "logging.level.changed": {
    channel: "logging",
    level: "warn",
    message: "Log level changed",
    fields: ["channel", "from", "to", "by"],
  },
  "logging.sink.dropped": {
    channel: "logging",
    level: "warn",
    message: "Log entries dropped before they reached the database",
    fields: ["dropped", "reason"],
  },
  "logging.sink.failed": {
    channel: "logging",
    level: "warn",
    message: "Log entries could not be written to the database",
    fields: ["count", "err"],
  },
} as const satisfies Record<string, EventDef>;

export type EventId = keyof typeof EVENTS;
