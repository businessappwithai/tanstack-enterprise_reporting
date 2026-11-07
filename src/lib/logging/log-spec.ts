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
 * carries `debug` events, so each is declared at debug.
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
  // Operations that used to be console lines. One id per area and outcome, with `what`
  // naming the operation; give a call that matters an event of its own.
  "app.misc.degraded": { channel: "app", level: "warn", message: "Application degraded; continuing", fields: ["what"] },
  "app.misc.failed": { channel: "app", level: "error", message: "Application failed", fields: ["what"] },
  "app.serverfn.failed": { channel: "app", level: "error", message: "Server function failed", fields: ["what"] },
  "app.startup.degraded": { channel: "app", level: "warn", message: "Start-up degraded; continuing", fields: ["what"] },
  "app.startup.failed": { channel: "app", level: "error", message: "Start-up failed", fields: ["what"] },
  "auth.check.failed": { channel: "auth", level: "error", message: "Access check failed", fields: ["what"] },
  "client.ui.degraded": { channel: "client", level: "warn", message: "Interface degraded; continuing", fields: ["what"] },
  "client.ui.failed": { channel: "client", level: "error", message: "Interface failed", fields: ["what"] },
  "datasource.connection.degraded": { channel: "datasource", level: "warn", message: "Data source connection degraded; continuing", fields: ["what"] },
  "datasource.connection.failed": { channel: "datasource", level: "error", message: "Data source connection failed", fields: ["what"] },
  "datasource.inspection.failed": { channel: "datasource", level: "error", message: "Data source inspection failed", fields: ["what"] },
  "datasource.inspection.trace": { channel: "datasource", level: "debug", message: "Data source inspection trace", fields: ["what"] },
  "datasource.service.failed": { channel: "datasource", level: "error", message: "Data source service failed", fields: ["what"] },
  "db.bootstrap.degraded": { channel: "db", level: "warn", message: "Database bootstrap degraded; continuing", fields: ["what"] },
  "db.bootstrap.trace": { channel: "db", level: "debug", message: "Database bootstrap trace", fields: ["what"] },
  "db.core.failed": { channel: "db", level: "error", message: "Database failed", fields: ["what"] },
  "db.core.trace": { channel: "db", level: "debug", message: "Database trace", fields: ["what"] },
  "email.send.failed": { channel: "email", level: "error", message: "Email delivery failed", fields: ["what"] },
  "graph.sync.degraded": { channel: "graph", level: "warn", message: "Knowledge graph sync degraded; continuing", fields: ["what"] },
  "graph.sync.trace": { channel: "graph", level: "debug", message: "Knowledge graph sync trace", fields: ["what"] },
  "jobs.export.failed": { channel: "jobs", level: "error", message: "Export job failed", fields: ["what"] },
  "jobs.monitoring.degraded": { channel: "jobs", level: "warn", message: "Monitoring degraded; continuing", fields: ["what"] },
  "jobs.monitoring.failed": { channel: "jobs", level: "error", message: "Monitoring failed", fields: ["what"] },
  "jobs.monitoring.trace": { channel: "jobs", level: "debug", message: "Monitoring trace", fields: ["what"] },
  "jobs.runner.failed": { channel: "jobs", level: "error", message: "Job runner failed", fields: ["what"] },
  "jobs.runner.trace": { channel: "jobs", level: "debug", message: "Job runner trace", fields: ["what"] },
  "nlquery.openkb.degraded": { channel: "nlquery", level: "warn", message: "OpenKB degraded; continuing", fields: ["what"] },
  "nlquery.openkb.failed": { channel: "nlquery", level: "error", message: "OpenKB failed", fields: ["what"] },
  "nlquery.openkb.trace": { channel: "nlquery", level: "debug", message: "OpenKB trace", fields: ["what"] },
  "nlquery.pipeline.degraded": { channel: "nlquery", level: "warn", message: "Natural-language pipeline degraded; continuing", fields: ["what"] },
  "nlquery.pipeline.failed": { channel: "nlquery", level: "error", message: "Natural-language pipeline failed", fields: ["what"] },
  "nlquery.rag.degraded": { channel: "nlquery", level: "warn", message: "Retrieval (RAG) degraded; continuing", fields: ["what"] },
  "nlquery.translate.degraded": { channel: "nlquery", level: "warn", message: "SQL translation degraded; continuing", fields: ["what"] },
  "nlquery.translate.failed": { channel: "nlquery", level: "error", message: "SQL translation failed", fields: ["what"] },
  "nlquery.translate.trace": { channel: "nlquery", level: "debug", message: "SQL translation trace", fields: ["what"] },
  "report.worker.degraded": { channel: "report", level: "warn", message: "Report generation degraded; continuing", fields: ["what"] },
  "report.worker.failed": { channel: "report", level: "error", message: "Report generation failed", fields: ["what"] },
  "report.worker.trace": { channel: "report", level: "debug", message: "Report generation trace", fields: ["what"] },
  "sql.editor.degraded": { channel: "sql", level: "warn", message: "SQL editor degraded; continuing", fields: ["what"] },
  "sql.editor.failed": { channel: "sql", level: "error", message: "SQL editor failed", fields: ["what"] },
  "voice.client.failed": { channel: "voice", level: "error", message: "Voice failed", fields: ["what"] },
  "db.bootstrap.password_generated": {
    channel: "db",
    level: "warn",
    message: "A random password was generated",
    fields: ["label"],
  },
  "db.bootstrap.password_ignored": {
    channel: "db",
    level: "warn",
    message: "A bootstrap password variable was ignored",
    fields: ["variable", "reason"],
  },
  "jobs.workers.started": {
    channel: "jobs",
    level: "info",
    message: "Background workers started",
    fields: ["backend", "concurrency"],
  },
  "jobs.workers.stopped": { channel: "jobs", level: "info", message: "Background workers stopped", fields: [] },
  "jobs.email_batch.started": { channel: "jobs", level: "info", message: "Email batch started", fields: ["total"] },
  "jobs.email_batch.completed": {
    channel: "jobs",
    level: "info",
    message: "Email batch completed",
    fields: ["total", "sent", "failed"],
  },
  "jobs.email_batch.recipient_failed": {
    channel: "jobs",
    level: "warn",
    message: "An email in the batch could not be sent",
    fields: ["position", "reason"],
  },
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
