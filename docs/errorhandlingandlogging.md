# Logging and error handling — the generated application and Enterprise Reporting

## Context

Both products already log through **Pino**, but they are at very different stages, and neither handles errors by category.

**The generated application** (NestJS + TanStack, `app-with-ai-tanstack/packages/generator/templates/tanstack-start-nestjs/`) has a good base:
- `backend/src/common/logging/logger.service.ts.hbs` (523 lines): Pino, levels resolved per channel (`LOG_LEVEL`, `LOG_LEVEL_<CHANNEL>`), redaction, an `AsyncLocalStorage` request context, a Fastify `onResponse` HTTP hook, and process-level handlers.
- `log-spec.json` comes from the canonical `packages/core/src/logging/log-spec.json` through `generatedLogSpec()` in `packages/generator/src/logging/generated-spec.ts`.

The gaps:
- Only about 25 `.event()` calls exist across the whole backend.
- **24 files still use Nest's `new Logger(...)`** with free-text lines.
- `console.*` is still used in `migrate`, `seed`, `database.module`, `main`, `better-auth` and the trigger task.
- Errors are thrown as raw Nest exceptions: about 46 `BadRequest`, 32 `Conflict`, 31 `NotFound` and so on.
- Only eight ad-hoc `details.code` values exist (`VERSION_CONFLICT`, `WORKFLOW_FAILED`, …), with no central list of them and no category.
- `http-exception.filter.ts.hbs` maps database SQLSTATEs well but logs through a second logger. Nothing logs by category.
- The front end's `lib/api-client.ts` has its own `console`-based `Logger` with no levels the operator controls, and browser errors are never reported to the server.

**Enterprise Reporting** (`tanstack-enterprise_reporting/src/`) is weaker:
- `lib/logging/logger.ts` always uses the `pino-pretty` transport (wrong in production) and has no redaction.
- It writes to the `logs` table through an unbounded queue, one `INSERT` per line, re-queues on failure, and registers its own `SIGTERM`/`SIGINT` handlers that call `process.exit`.
- Only 4 files import it. There are **530 `console.*` calls in 158 files**.
- Errors live in three unconnected systems:
  - `ServerFunctionError` and its subclasses, used in 7 files;
  - about 130 hand-written `{ error: { code } }` answers across 82 API routes;
  - `errorManagementService` and `errorLogger` (the browser's error log, kept in `sessionStorage`).
- There is no request id and no request context.

**Goal:** one design used in both places:
- events declared in a spec;
- errors grouped by category, each category with a set log level, HTTP status and level of exposure;
- one log line per failure, carrying a correlation id;
- all of it controlled by log level;
- held to the design by tests, so the code cannot drift from it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Logger | **Pino 9**, kept in both | The fastest structured logger for Node and Bun, with good TypeScript types, built-in `redact`, child loggers and `err` serialisers. It is already installed in both, so there is no migration cost. Winston, Bunyan and tslog are slower, or add nothing Pino lacks |
| Call shape | `getLogger(channel).event(id, fields)` | The convention `CLAUDE.md` already sets. Level and message come from the spec, so call sites cannot drift |
| Error model | One `AppError` hierarchy plus a **declared error list** (code → category, status, level, public message) | Category-based handling and logging need the category to be a fact about the error, not the call site's guess |
| Destination | stdout (JSON in production, pretty in development). Enterprise Reporting also keeps the `logs` table, but only for `warn` and above, written in batches | The existing spec rule ("stdout only"). Enterprise Reporting's System Logs screen reads the table, so that table stays |
| Correlation | `x-request-id` (accepted if it arrives, otherwise generated), held in `AsyncLocalStorage` and returned on every response and error body | Lets a user's report ("error ref 7f3a…") be found in the logs |
| Tracing | An optional OpenTelemetry hook: `traceId` and `spanId` are added to log lines when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | A later phase. It adds no dependency until someone turns it on |
| Browser stack (`--standalone`) | Out of scope | It has a different runtime (`templates/wasm/`). This plan covers the NestJS stack that `CLAUDE.md` makes mandatory |

## 1. The shared contract

### 1.1 Error categories

These are fixed and the same in both products.

| Category | HTTP | Log level | Exposed to the client | Examples |
|---|---|---|---|---|
| `validation` | 400/422 | warn | message plus field details | bad payload, `''` on a date, field logic |
| `authentication` | 401 | warn | generic message | no session, expired session |
| `authorization` | 403 | warn | generic message plus code | `TRANSITION_FORBIDDEN`, `STATE_FIELD_SYSTEM_MANAGED`, entity read denied |
| `not_found` | 404 | info | yes | record, report, data source |
| `conflict` | 409/428 | info | yes | `VERSION_CONFLICT`, `RECORD_FINAL`, unique violation, `PRECONDITION_REQUIRED` |
| `business_rule` | 422 | info | the rule's message | `RULE_REFUSED`, `prevent` |
| `workflow` | 422 | warn | workflow and phase | `WORKFLOW_FAILED`, `INVALID_TRANSITION` |
| `rate_limit` | 429 | warn | `retryAfter` | sign-in throttle |
| `integration` | 502/503/504 | error | generic message plus ref | LLM, SMTP, Trigger.dev, external data source unreachable |
| `database` | 500/503 | error | generic message plus ref | pool exhausted, SQLSTATEs not mapped elsewhere |
| `configuration` | 500 | fatal at boot, error at run time | generic message | missing `ENCRYPTION_KEY`, an invalid TTL |
| `internal` | 500 | error | generic message plus ref only | any unexpected exception |

The rules:
- **4xx is the client's problem, so it never logs at `error`.** It logs at warn or info.
- **5xx always logs at `error`**, with the stack and `cause`, and the client gets only `message` and `ref` (the request id).
- A database constraint violation (the existing `mapDatabaseError`) becomes `conflict` or `validation`, not `database`.

### 1.2 The error catalogue

Add an `errors` section to `packages/core/src/logging/log-spec.json`, beside `channels` and `events`:

```json
{ "code": "VERSION_CONFLICT", "category": "conflict", "status": 409,
  "message": "Someone else saved this record first.", "surfaces": ["generated"] }
```

- `generatedLogSpec()` filters it by `surfaces`, as it already filters channels.
- Add the matching events: `http.request.rejected` and `error.unhandled`, and one `error.<category>` event per category so that dashboards can count each one.

### 1.3 The response envelope

The NestJS shape already exists. The change is that every product answers the same way.

```json
{ "statusCode": 409, "error": "Conflict", "message": "…",
  "details": { "code": "VERSION_CONFLICT", "category": "conflict", ... },
  "ref": "req_7f3a…", "timestamp": "…", "path": "…" }
```

`details.code` stays where it is, because generated suite 22 and the front end's `version-conflict.ts` read it there. This is additive only.

## 2. The generated application

All of these paths are under `packages/generator/templates/tanstack-start-nestjs/`.

### 2.1 Backend

1. **`backend/src/common/errors/app-error.ts`** (new, not `.hbs`). It holds:
   - `AppError extends HttpException`, with `{ code, category, details, cause, expose }`;
   - helpers built from the catalogue: `appError("VERSION_CONFLICT", details)`, plus subclasses `ValidationAppError`, `ConflictAppError` and so on;
   - `categoryOf(err)`, which classifies anything: an `AppError`, a Nest `HttpException` by status, a driver error by SQLSTATE (moved here from the filter), or a zod or class-validator error.

   **`backend/src/common/errors/catalogue.ts`** (generated from the spec, the same way `log-spec.json` is) gives a typed `ErrorCode` union, so `appError("TYPO")` fails `bun check`.
2. **`http-exception.filter.ts.hbs`** rewrite. It becomes the one place an exception turns into a response:
   - it classifies with `categoryOf`;
   - it builds the envelope with `ref`;
   - it hides the message on 5xx;
   - it stashes `{ category, code }` on the request next to `__logError`.

   It stops logging; the `onResponse` hook in `logger.service.ts.hbs` writes the single line, at the level set for that category. This keeps the existing "the HTTP hook, never an interceptor" rule.
3. **`logger.service.ts.hbs`**:
   - add `pino.stdSerializers.err` with `cause` chains;
   - add `requestId` from `x-request-id` (generated with `crypto.randomUUID()` when missing) and echo it as a response header;
   - add `errorCategory` and `errorCode` fields to `http.request.*`;
   - a `LOG_SAMPLE_DEBUG` rate (optional);
   - `GET/PUT /sys/logging/levels`, administrator-only, to change a channel's level at run time without a restart (kept in memory and reset on restart). Gate it behind the `logging:*` grant in `sys_access_grant`.
4. **Replace Nest `Logger` with spec events in the 24 files.** Representative files:
   - `modules/bus/{bus.service,transition.service,entity-promotion.service}.ts.hbs`
   - `modules/rules/rules-engine.service.ts.hbs`
   - `modules/workflow/workflow.service.ts.hbs`
   - `modules/jobs/job-queue.service.ts.hbs`
   - `modules/auth/guards/session-auth.guard.ts.hbs`
   - `modules/audit/*`
   - `modules/notifications/notifications.service.ts`

   Add new events to the spec first: `workflow.run.started|completed|failed`, `jobs.*`, `audit.write.failed`, `notifications.send.failed`, `auth.session.unavailable` (the 503 path) and `modelcontext.*`. `AppLoggerService` stays as the bridge for Nest's own framework lines.
5. **Raw `throw new XxxException(...)`** (about 120 call sites) becomes `appError(code, …)` where a code exists or should exist. Plain `NotFoundException` and `BadRequestException` may stay, because `categoryOf` classifies them by status. A code is required wherever a client or a suite branches on the error.
6. **Scripts and workers** (`migrate.ts.hbs`, `seed.ts.hbs`, `database.module.ts.hbs`, `trigger/*.task.ts.hbs`, `lib/better-auth.ts.hbs`) move to `getLogger('db'|'app'|'workflow')`:
   - events: `db.migration.applied|failed` (already declared), `db.seed.completed|failed`;
   - better-auth's own logger is routed to the `auth` channel;
   - the job worker sets a job context in `AsyncLocalStorage` (`jobId` in place of `requestId`).
7. **Process lifecycle**: `installProcessLogging` already logs `app.uncaught`. It also gains:
   - `unhandledRejection` at `error`, so the process keeps running;
   - `uncaughtException` at `fatal`, then a flush and `exit(1)`;
   - a graceful `SIGTERM` that drains Fastify and then calls `logger.flush()`.

### 2.2 Front end

1. **`frontend/src/lib/logger.ts`** (new): a small logger with levels.
   - Its level comes from `VITE_LOG_LEVEL`, defaulting to `warn` in production and `debug` in development.
   - The same redaction keys as the spec.
   - It replaces the `console`-based `Logger` class in `lib/api-client.ts`.
2. **`ApiError`** in `api-client.ts` gains `code`, `category` and `ref`, parsed from the envelope. `isCategory(err, "conflict")` replaces status-number checks. `version-conflict.ts` keeps working because it reads `details.code`.
3. **Browser error reporting**:
   - `POST /api/client-logs` on the backend, bounded the way Enterprise Reporting's `lib/logging/client-log.ts` already does it: level allowlist, a 4,000-character message, 8 KB of metadata, 60 entries a minute per user, and `source: "client"` stamped on each entry. Copy that design rather than inventing one.
   - It logs to a new `client` channel and never stores anything.
   - Callers: `RootErrorComponent` in `routes/__root.tsx.hbs`, `window.onerror` and `unhandledrejection`, and TanStack Query's global `onError`.
4. **What the user sees**: the error toast and `RootErrorComponent` show the friendly message plus "Reference: `<ref>`", so support can find the log line. The 401 sign-out logic stays, and the session guard's 503 is shown as "couldn't check your sign-in" with a retry.

### 2.3 Generator side

- `generated-spec.ts`: emit `errors` filtered by surface, and also write `catalogue.ts`.
- Register the new template files wherever `common/` files are copied today (the same mechanism `ttl-cache.ts` uses). No migration is needed: nothing is stored.
- `.env.example` template: document `LOG_LEVEL`, `LOG_LEVEL_<CHANNEL>`, `LOG_PRETTY`, `VITE_LOG_LEVEL`, `HTTP_SLOW_REQUEST_MS` and `DB_SLOW_QUERY_MS`.
- **Stale bundles**: anything under `packages/generator/src` stales `html/assets/appwithai-fullstack.js` (and possibly `viewers/eml-model.js`). Rebuild on Bun 1.4.4 on linux-x64, in Docker if the local platform differs, and run all five `--check`s.
- Check that the WASM overlay footprint (9 files changed, 6 added) is unchanged. New backend files are copied untouched.

## 3. Enterprise Reporting

All of these paths are under `tanstack-enterprise_reporting/src/`.

1. **Logger core** (`lib/logging/`):
   - `log-spec.json` (new), with this product's own channels: `http`, `auth`, `db`, `datasource`, `nlquery`, `sql`, `jobs`, `report`, `email`, `graph`, `voice`, `client`, `app`. It follows the same shape as the generator's spec, and the levels and redaction lists match.
   - `logger.ts` rewritten:
     - one root Pino with `redact`;
     - pretty output only when `LOG_PRETTY=1` or in development; JSON otherwise;
     - `getLogger(channel).event(...)`;
     - `LOG_LEVEL` and `LOG_LEVEL_<CHANNEL>`.

     `createLogger(context)` stays as a thin shim so the 4 existing callers keep working, and is then removed.
   - `request-context.ts` (new): `AsyncLocalStorage` holding `{ requestId, userId, route }`.
   - Database sink (`db-sink.ts`):
     - a Pino destination stream filtered by `LOG_DB_LEVEL`, default `warn`;
     - bounded ring buffer of 1,000 entries; it drops the oldest and counts drops in a `logging.sink.dropped` warn line;
     - one multi-row `INSERT` per flush;
     - no `process.exit`. Flushing moves into a single shutdown hook registered by the server entry.
   - **Never log plaintext connection configs or key material.** Add `connection_config`, `connectionString`, `ENCRYPTION_KEY` and `sql_params` to the redaction list.
2. **Errors** (`lib/errors/`):
   - `app-error.ts`: the same categories, and the same `AppError(code, …)` shape as the generated application.
   - `catalogue.ts`: this product's codes. The 130 existing hand-written codes become catalogue entries: `UNAUTHORIZED`, `NOT_FOUND`, `INVALID_INPUT`, `FORBIDDEN`, `RATE_LIMITED`, `QUERY_NOT_FOUND`, `SQL_REQUIRED`, plus new ones for `validateQueryAccess` denials (`QUERY_ACCESS_DENIED`) and read-only refusals (`QUERY_NOT_READ_ONLY`).
   - `ServerFunctionError`, `ValidationError`, `UnauthorizedError` and `NotFoundError` become subclasses of `AppError` and keep their names, so the 7 callers of `withErrorHandler` do not change.
   - `SessionUnavailableError` is given category `database` and status 503.
   - `categoryOf()` also classifies `pg`, `mysql2` and `mssql` driver errors (an unreachable external data source is `integration`, not `internal`), plus zod and Better Auth errors.
3. **One wrapper for API routes**: `lib/http/with-api-handler.ts` (new) wraps `server.handlers` functions. It:
   - sets up the request context and request id;
   - times the request and logs `http.request.completed|client_error|failed` at the category's level;
   - catches any throw, then builds the envelope (`{ success: false, error: { code, category, message, ref } }`, the shape the routes already use) and hides the message on 5xx;
   - calls `logAudit` for `authorization` failures, as `withErrorHandler` already does.

   Migrate the 82 routes under `routes/api/`, starting with the security-sensitive ones:
   - `sql/execute`, `nl-query/*`, `data-sources/*`, `reports/*`, `jobs/*`, `datasets/*/data`;
   - then the rest.

   Keep the rule that the request body is read once, outside the `catch`. The wrapper takes the parsed body so the old "read it again in the catch" bug cannot come back.
4. **Server functions**: `withErrorHandler` sends its failure lines through the same logger, picks the level from the category, and adds `ref`.
5. **`console.*` sweep** (530 calls): replace them per module, using these channels:

   | Code | Channel |
   |---|---|
   | `connection-manager.ts` (including the `[TEST_CONNECTION]` diagnostics, now one structured `datasource.test.failed` event with `errorCode` and `durationMs`) | `datasource` |
   | `nlquery/`, `mastra/` | `nlquery` |
   | `jobs/` and workers (job context: `jobId`, `jobDefinitionId`) | `jobs` |
   | `report-generation/` | `report` |
   | `email` | `email` |
   | `graph/` | `graph` |
   | `voice/` | `voice` |

   Client components and hooks use the browser logger instead.
6. **Browser** (`lib/errors/error-logger.ts` and `components/errors/error-boundary.tsx`):
   - keep the `sessionStorage` copy;
   - send each entry to the existing bounded `POST /api/logs` (`client-log.ts`), throttled;
   - show the error report dialog with `ref`.

   `errorManagementService` (the `error_messages` and `warning_configs` tables) becomes the lookup for a code's display message, keyed by catalogue code, so administrators can reword messages without a deploy.
7. **Process**:
   - the server entry and `worker-runner.ts` install `unhandledRejection` and `uncaughtException` handlers;
   - both `pg` pools keep their `error` listeners and log `db.pool.error`;
   - shutdown flushes the database sink.
8. **System Logs screen**: add filters for `category`, `code` and `request_id`. The columns already exist except `category` and `code`. Add those to `bootstrap.ts` and to the `Database` interface **together**, as `CLAUDE.md` requires.

## 4. Across both products

- The `requestId` travels end to end:
  - generated front end → generated backend (`x-request-id`);
  - the reporting seeder and the "open record" links carry nothing sensitive;
  - Enterprise Reporting's `/api/*` → Mastra (`x-request-id` forwarded in `/api/copilotkit`).
- The same category names and the same level per category in both specs. A test (below) asserts the two lists match, through a copy of the categories table in each repository.

## 5. Tests that hold the design

| Test | Where | What it asserts |
|---|---|---|
| spec conformance (extended) | `packages/core/src/logging/__tests__/spec-conformance.test.ts`, plus a template variant scanning `templates/**/*.hbs` | every `.event()` id is declared; every declared event is emitted; **every `appError("X")` code is in `errors`** |
| no stray loggers | `templates/__tests__/no-console-logging.test.ts` (new) and Enterprise Reporting's `src/lib/logging/__tests__/no-console.test.ts` | no `console.*` and no `new Logger(` in server code (allowlist: `AppLoggerService`, CLI banners) — a static scan, like Enterprise Reporting's existing "no body read in catch" test |
| category mapping | `common/errors/__tests__` and Enterprise Reporting's `lib/errors/__tests__` | each category gives the right status and level; 5xx hides the message; SQLSTATE 23505 → conflict; `ECONNREFUSED` from a data source → integration |
| redaction | both `logger.test.ts` | reads the JSON actually written (the existing pattern) and checks that the password, cookie, `connection_config` and API key values are censored |
| envelope | generated suite (new `02d-error-envelope`) | a 404, a 409 `VERSION_CONFLICT`, a 403 and a forced 500 each carry `details.code`, `details.category` and `ref`, and that `ref` equals the `x-request-id` response header |
| level control | generated suite plus an Enterprise Reporting unit test | `LOG_LEVEL_RULES=silent` silences that channel only; the run-time level endpoint changes the level and refuses a non-administrator |
| client sink | both | an oversized or too-fast `POST` is rejected with 413 or 429; the logged line has `source: "client"` |

## Phases

1. **The contract**: categories, catalogue, the spec `errors` section and the `generatedLogSpec` change. Tests 1 and 3.
2. **Generated backend**: `AppError`, the filter, the logger additions, then replacing Nest `Logger` across the 24 files, then the scripts. Bundle rebuild.
3. **Generated front end**: the logger, `ApiError`, client logs, the `ref` in the UI.
4. **Enterprise Reporting core**: logger, database sink, request context, `AppError`, `withApiHandler`, then the routes from most to least sensitive.
5. **Enterprise Reporting sweep**: the `console.*` sweep by module, browser reporting, System Logs filters.
6. **Optional**: OpenTelemetry trace ids, debug sampling.

## Verification

**Generator repository:**
- `bun install`, `bun run type-check`, `bun run test` (conformance, redaction, the no-console tests).
- All five `build:* --check`s, run on Bun 1.4.4 on linux-x64.
- `bun run wasm generate -i examples/drug-discovery.eml.mmd -o /tmp/app --records-per-entity 25`, build the backend and front end, then run the generated suite with `node run.ts --no-server` against Postgres, including `02d-error-envelope`. **Run it twice on one database.**
- Manually: `LOG_LEVEL=debug` versus `warn` changes the output; a forced 500 shows a stack in the logs and only the `ref` in the browser; a stale save gives a 409 at info level with `VERSION_CONFLICT`.

**Enterprise Reporting:**
- `bun run typecheck`, `bun run test` (also as `env -u AUTH_SECRET bun test src`), and `bun --bun vite build` (with `routeTree.gen.ts` unchanged).
- Manually under `vite dev`:
  - a SQL Editor query against a missing table gives `validation`/warn;
  - a denied table gives a 403 `QUERY_ACCESS_DENIED`/warn that is also audited;
  - a stopped external database gives `integration`/error with a `ref`.
- System Logs filters by `ref`.
- Stopping PostgreSQL does not crash the process (pool `error` listener) and produces no unbounded log growth (ring-buffer drops are counted).
