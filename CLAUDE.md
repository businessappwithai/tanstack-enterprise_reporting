# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Bun 1.4.4, and only Bun 1.4.4

**Every repository in this project uses Bun 1.4.4 and no other version** —
`app-with-ai-tanstack`, `app-and-report-with-ai-rust` (the orchestrator),
`enterprise_reporting_tanstack` and `businessappwithai.github.io`. That is the
rule for every runtime, install, build, test, type-check and lint, in CI, in
Docker images and locally. There are no exceptions: the WASM build and the
`appwithai-wasm` CLI run on 1.4.4 too.

- **Never use another Bun.** Not 1.3, not 1.4.0–1.4.3, not a newer release. Bun's
  bundler output depends on the exact version, so a committed bundle built on
  another one is byte-wrong for CI; and a Bun older than 1.4.3 has no type
  checker behind `bun check` at all.
- **The linter is `bun check`, and only `bun check`.** Every `lint` and
  `type-check` script runs it; no repository carries Biome, ESLint, Prettier or
  any other linter or formatter, and none runs `tsc` as its static check. Style
  is kept by hand.
- **No `package.json` may have a script named `check`.** On 1.4.4 as on every
  earlier Bun, `bun check` in a directory whose manifest has a `check` script
  runs that script instead of the type checker, silently. Measured in the
  orchestrator: its `lint` (`bun check`) ran the whole `check` chain, which ran
  `lint` again. Name an aggregate script `check:all`.
- **Never use npm, pnpm or yarn** as the package manager.
- **Pin it exactly** wherever a version is stated: `BUN_VERSION: "1.4.4"` in CI,
  `bun-version: 1.4.4` in a `setup-bun` step, `oven/bun:1.4.4` in Dockerfiles,
  `"bun": ">=1.4.4"` in `engines`, `1.4.4` in `.bun-version`. Moving to a
  different Bun is one deliberate change made in all four repositories together,
  never in one alone.
- **What a generated application runs on is a separate question.** The browser
  (WASM) application the generator writes is Bun-free by design — its overlay
  swaps bun for node — and that is about the *output*, not the toolchain that
  produced it.

**Here:** CI (`.github/workflows/ci.yml`), `Dockerfile` and `Dockerfile.mastra`
pin 1.4.4, and `package.json` asks for `>=1.4.4`. `bun run typecheck` and `bun run lint` are both `bun check`.

**Cloud sessions are pinned too.** `.bun-version` is the single statement of the
version, and the `SessionStart` hook in `.claude/settings.json`
(`.claude/hooks/session-start.sh`) installs exactly that Bun when the image ships a
different one, then runs `bun install --frozen-lockfile`. It exits non-zero rather
than carry on if it cannot get the pinned version, because a session on another Bun can
report a check that never ran. It only acts when `CLAUDE_CODE_REMOTE=true`.
Moving to another Bun means changing `.bun-version`, CI, both Dockerfiles and the other
three repositories together.

## Commands

```bash
# Development
bun --bun vite dev            # dev server at http://localhost:4050
bun --bun vite build          # production build
bun run start                 # serve it — listens on :3000, PORT overrides

# Code quality — bun check is the whole static check and the linter (no other linter, no formatter)
bun run typecheck             # bun check — Bun's own type checker
bun run lint                  # the same bun check
bun run test                  # bun test src — the unit tests (CI runs this too)
bun run precommit             # typecheck, then the unit tests

# Database (PostgreSQL — config DB and knowledge graph)
bun scripts/rebuild-db.ts                  # full schema rebuild (drops + recreates all tables)
bun src/lib/db/seeds/001_initial_data.ts   # seed sample data + Sakila data source
bun scripts/init-postgres.ts               # init PostgreSQL user DBs with pgvector tables

# Knowledge graph (Apache AGE)
bun scripts/sync-knowledge-graph.ts       # bootstrap AGE + sync schema + import llmtext

# Background jobs (Trigger.dev tasks, or built-in cron fallback)
bun src/lib/jobs/worker-runner.ts         # start background jobs worker

# Load a generated application into this platform (see "The reporting-pack seeder")
REPORTING_PACK=./pack.json APP_DATABASE_URL=postgresql://… \
  bun scripts/seed-reporting-pack.ts

# Unit tests (bun:test). Scope to src — see "Testing" below, a bare `bun test`
# also picks up the Playwright specs under e2e/ and errors on all of them.
bun test src                                # what `bun run test` runs

# E2E tests (start dev server first — webServer config is commented out in playwright.config.ts)
playwright test                             # all tests
playwright test --headed                    # visible browser
playwright test --ui                        # Playwright UI
playwright test e2e/sql-editor.spec.ts      # single spec file
playwright test e2e/sql-editor.spec.ts -g "saves a query"   # single test by name
bun run test:setup && playwright test       # setup test data then run all
```

## Architecture

### Framework and Runtime

TanStack Start v1 (`@tanstack/react-start` ^1.167.65) with file-based routing. Requires Bun ≥ 1.4.4 (CI and both Dockerfiles pin 1.4.4). React 19, Vite 7, Tailwind 3, shadcn/ui over Radix. There is no linter or formatter — see **`bun run precommit`** below.

**The dev server and the production server are on different ports.** `vite dev`
listens on **4050**; `bun run start` serves the build on **3000**, and `PORT`
overrides it. The Playwright suite and `BASE_URL` both default to 4050.

`vite.config.ts` carries three things worth not undoing:

- `server.headers` sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` — cross-origin isolation, which
  DuckDB WASM needs for `SharedArrayBuffer`.
- `ssr.external: ['better-auth']` — see **Auth** below. Bundling it breaks every
  sign-in at runtime while the build and typecheck both pass.
- `resolve.dedupe` on React and `optimizeDeps.include` for the same: two copies of
  React in one page is a hooks error with no useful stack.

### Two-Database Architecture

**Config DB (PostgreSQL only)** — `src/lib/db/kysely-db.ts`, re-exported from `src/lib/db/config.ts`:

```ts
import { getDb } from "@/lib/db/config";
```

- Connection via `DATABASE_URL`, else assembled from `POSTGRES_HOST/PORT/DB/USER/PASSWORD` (or `PGHOST`/`PGPORT`/… ), defaulting to `localhost:5432/enterprise_config` as user `enterprise`
- `getDb()` is synchronous; bootstraps schema on first call via `bootstrapSchema()` in `src/lib/db/bootstrap.ts` — idempotent (`CREATE TABLE IF NOT EXISTS`), safe to run every boot
- Stores everything: users, roles, user_roles, resource_permissions, data_sources, saved_queries, report_definitions, chart_definitions, dashboard_layouts, dashboard_widgets, job_definitions, job_executions, audit_log, logs, email_templates, filter_definitions, report_filters, chart_filters, ds_roles, ds_user_roles, ds_entity_permissions, schema_table_instructions, schema_field_instructions, metadata_entity_header, metadata_entity_field, error_messages, warning_configs, error_occurrences, app_settings, nl_query_context, nl_query_role_stats, nl_query_feedback, help_articles, datasets — plus `auth_sessions`, `auth_accounts` and `auth_verifications` for Better Auth
- The `Database` interface in `src/lib/db/kysely-db.ts` is the authoritative type for all config DB tables — add a table there and in `bootstrap.ts` together

**Seven tables exist in `bootstrap.ts` that the `Database` interface does not
declare**, so the rule above is already broken in one direction: `ds_schema_cache`,
`adk_intents`, `monitoring_rules`, `monitoring_executions`, `notifications`,
`nl_report_definitions` and `generated_report_artifacts`. Code that reads them —
`monitoring-worker.ts` and `monitoring-scheduler.ts` are the main ones — is
selecting from a table Kysely has no type for. Adding the missing interfaces is
worth doing; until then, do not assume the interface is a complete inventory of
the schema. `bootstrap.ts` is.
- **Knowledge graph** (`ers_knowledge` database): Apache AGE property graph for NL query context; separate pool in `src/lib/graph/client.ts` via `GRAPH_DATABASE_URL`

There is no MariaDB or SQLite anywhere in the running system, despite what several files under `docs/` still claim (see **Stale documentation** below).

**User Data Sources** — `src/lib/db/connection-manager.ts`:

```ts
import { getConnection } from "@/lib/db/connection-manager";
const kysely = await getConnection(dataSource);  // Kysely<any>
```

- Returns a Kysely instance for the user's external database
- Supported `client_type` values: `pg`, `mysql`, `mssql`
- Connection configs stored AES-256-GCM encrypted (`ENCRYPTION_KEY` env var) in the config DB's `data_sources` table; decrypted via `src/lib/security/encryption.ts`
- **An unset `ENCRYPTION_KEY` is now fatal.** It used to warn and fall back to a hard-coded development key, which left every stored data-source password unprotected while only writing one line to a boot log that nothing failed on. Local development that wants the old behaviour must set `ALLOW_INSECURE_ENCRYPTION=1`, and that is refused outright when `NODE_ENV=production`.
- **The key is the ciphertext's only input, so rotating it strands every stored config.** There is no re-encryption path; the failure looks like a data source that exists and cannot be opened. Generate it once, before first boot.
- `encryption.ts` used to log twenty-four `[ENCRYPTION DEBUG]` lines per call on the normal path, ending with the first 200 characters of the plaintext — which for a data source is the whole connection config, password included, in every `docker compose logs`. It does not any more. Do not add diagnostics that print plaintext or key material here.
- Connections pooled by data source ID and health-checked before reuse
- Hostnames are resolved to IPv4 explicitly (`resolveIPv4`) because Docker DNS returns IPv6 first and that path fails against Neon pooler endpoints — keep `ssl.servername` set when changing this

### Route Structure

File-based routing under `src/routes/`:

```
src/routes/
├── __root.tsx     # ErrorBoundary → ThemeProvider → TanStackDBWrapper → DuckDBProvider
│                  #   → TooltipProvider → QueryClientProvider → HelpProvider
├── _authed.tsx    # Auth guard: resolves the session from request headers via
│                  #   getSessionFromHeaders, redirects to /login when absent
├── _authed/       # Protected pages: dashboard, sql-editor, nl-query, charts, dashboards, reports,
│                  #   queries, saved-queries, data-sources, datasets, metadata, filters, jobs,
│                  #   monitoring, queue-management, trigger-board, logs, system-logs, settings,
│                  #   email-templates, admin, users, roles, permissions
├── api/           # API routes using server.handlers pattern
├── share/         # Public (unauthenticated) share links: chart, dashboard, report
├── login.tsx      # Public login page
└── index.tsx      # Root redirect
```

API routes pattern:

```ts
export const Route = createFileRoute("/api/some-path")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        return json({ ... }, { status: 200 });
      },
    },
  },
});
```

`src/routeTree.gen.ts` is generated — never edit it by hand.

### Server Functions — Critical Conventions

Server functions live in `src/server-fns/`. The TanStack Start Vite plugin only recognizes `.inputValidator()` — using `.validator()` causes a runtime crash because the Vite plugin preserves unknown method names verbatim in the client bundle.

```ts
// Correct: use .inputValidator() not .validator()
export const myFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data: { id } }) => { ... });

// Client call MUST pass { data: ... } wrapper when inputValidator is used:
const result = await myFn({ data: { id: "abc" } });

// Without inputValidator, no wrapper needed:
export const otherFn = createServerFn({ method: "GET" }).handler(async () => { ... });
await otherFn();
```

Newer server functions wrap logic in `withErrorHandler()` from `src/lib/server-fns/with-error-handler.ts`, which audit-logs failures and normalizes errors into `ServerFunctionError` subclasses (`ValidationError` 422, `UnauthorizedError` 401, `NotFoundError` 404). Older ones return `{ success: boolean, data?: T, error?: string }` directly.

### Auth — Better Auth, not a JWT

Authentication is **Better Auth** (`src/lib/auth/better-auth.ts`). It replaced a
hand-rolled HS256 JWT (`jose`) that carried the user, their roles and their
permissions inside the cookie, and the two properties that motivated the move
are the ones to keep in mind when changing anything here:

- **A JWT is a bearer claim, not a lookup.** Roles and permissions were frozen
  into the token at sign-in, so a role revoked at 09:00 was still granted by an
  unexpired token at 17:00. They are now read from `roles`/`user_roles` on every
  request, against the session's user id — revocation takes effect on the next one.
- **There was no way to end a session server-side.** Now there is a row to
  delete, and changing a password deletes the user's other sessions.

**The seam did not move.** `Session`, `SessionUser`, `auth()`, `requireAuth()`
and `verifySession(token)` keep the shapes they had, so the ~56 files that call
them were untouched. What changed underneath is that `verifySession` is a
database lookup rather than a signature check.

| Where you are | What to call |
|---|---|
| Server fn (`src/server-fns/`) | `import { requireAuth } from "@/lib/auth/middleware"`, then `await requireAuth()` |
| API route (`src/routes/api/`) | `import { auth } from "@/lib/auth/config"`, then `await auth(request)` |
| You hold a raw token, not a request | `verifySession(token)` from `@/lib/auth/session` |
| Route guard | `_authed.tsx` resolves the session in `beforeLoad` and injects `{ session }` into route context (`Route.useRouteContext()`) |

- `/api/auth/$` is Better Auth's own HTTP surface (sign-in, sign-out, session).
  `basePath` is `/api/auth`, so that splat route has to stay at exactly that path
  or every URL the library generates points at a 404.
- **The user table is the existing `users` table.** `roles`, `user_roles`,
  `resource_permissions`, `ds_user_roles` and the audit log all key on `users.id`,
  so Better Auth's `user` model is *mapped onto* `users` rather than given a table
  of its own. Only `email_verified` was added. Sessions, credentials and
  verifications get new tables — `auth_sessions`, `auth_accounts`,
  `auth_verifications` — with real `TIMESTAMPTZ` columns, because the older tables
  store timestamps as `VARCHAR` and Better Auth compares `expires_at` against a
  `Date`, which against a string does not error, it just stops expiring sessions.
- **Passwords stay bcrypt.** Better Auth hashes with scrypt by default; every
  password in an existing installation is a bcrypt hash and there is no converting
  one without the plaintext, so the `hash`/`verify` hooks keep `bcryptjs`. The
  credential lives in `auth_accounts.password` — **not** `users.password_hash`,
  which Better Auth never reads. A password-change path that writes the old column
  reports success while sign-in keeps accepting the old password. `bootstrapSchema()`
  copies each `users.password_hash` into `auth_accounts` once, so existing users
  sign in with the passwords they already have.

#### Two cookie traps, both of which read as "everyone is signed out"

- **Never match the cookie by hand.** The name is Better Auth's business —
  `ers.session_token` today, `__Secure-` prefixed once served over HTTPS — so
  prefer `auth(request)` / `getSessionFromHeaders(headers)`, which hand the real
  headers to the library. Where a raw token is genuinely all you have,
  `readSessionToken()` matches `SESSION_COOKIE_NAME` at a cookie boundary.
- **`COOKIE_PREFIX` is `ers` on purpose.** The generated application this platform
  sits beside sets `<project>_app.session_token`, Better Auth cookies are path `/`,
  and nginx serves both from one origin. The old unanchored
  `cookie.match(/session_token=([^;]+)/)` found the *first substring*, so
  `crm_app.session_token` arrived first alphabetically and its value was handed to
  `verifySession` — signed in, session valid, every permission gone, and the
  dashboard rendering "0 of 10 modules available" to a full administrator.

#### `better-auth` must stay external to the server build

`vite.config.ts` carries `ssr.external: ['better-auth']`. It depends on zod `^4`
and this application on zod `^3`; both are installed, v4 nested under
`better-auth` and v3 hoisted. Node's resolution gets that right and the bundler
flattens it, handing `better-auth` the hoisted v3 — which fails at runtime on
`z.looseObject is not a function`: a 500 on every sign-in, from a build that
succeeded and a typecheck that passed.

#### "Signed out" and "could not check" are different answers

`getSessionFromHeaders` and `verifySession` return `null` **only** when there is no session.
When the lookup throws — the database is restarting, a pooled connection dropped — they retry
once and then throw `SessionUnavailableError` (`src/lib/auth/session.ts`). They used to catch
everything and return `null`, and every caller reads `null` as "signed out": the `_authed` guard
redirected to `/login`, and `requireAuth` said UNAUTHORIZED. Under load that signed people out
whose cookies were fine.

- `_authed.tsx` has an `errorComponent`: an outage shows "We couldn't check your sign-in" with
  **Try again** (`router.invalidate()`), not a redirect. API routes answer it with their existing
  500. The message constant lives in `session-errors.ts` (no imports) so the component can read it
  without pulling `pg` and Better Auth into the client bundle.
- **Do not add a `catch { return null }` around a session lookup.** If a new caller needs to
  tolerate an outage, catch `SessionUnavailableError` by name.
- Both `pg` pools (config, graph) have an `error` listener. Without one, the server dropping an idle
  connection is an unhandled event and the **whole process exits** — stopping PostgreSQL for a
  second killed the dev server.

**Permissions reach the page with the session.** The `_authed` guard returns
`{ session, permissions }` (`loadUserPermissions`, `src/lib/auth/user-permissions.ts`) and
`SessionPermissionsContext` seeds `usePermissions`, so the sidebar renders its full menu on the
first paint. It used to fetch `/api/auth/permissions` after hydration and hide every gated item
until it returned. The query key carries the user id (it used to be shared across users in a tab),
and `/api/auth/permissions` returns the caller's roles' `resource_permissions` rows only — it used
to return the whole table.

### NL Query Pipeline

`/_authed/nl-query/` → CopilotKit sidebar → `/api/copilotkit` → Mastra AI server → llama.cpp → pgvector RAG

1. CopilotKit sidebar (`@copilotkit/react-ui`) proxies to `MASTRA_URL` (default `http://localhost:4111`) via `/api/copilotkit`
2. SQL generation: `src/lib/nlquery/mastra-connector.ts` or `src/lib/nlquery/llama-translator.ts`
3. LLM server: OpenAI-compatible at `LLAMA_REASONING_URL` or `AI_NL2SQL_BASE_URL`
4. RAG context from `src/lib/mastra/rag-store.ts`: `nl_query_embeddings` + `nl_schema_embeddings` pgvector tables in the user's PostgreSQL DB
5. Full pipeline: `src/lib/mastra/nl-query-pipeline.ts` — schema fetch → LLM SQL generation → SQL AST validation → RBAC check → execute
6. Agent/tool orchestration variant: `src/lib/adk/pipeline.ts` (+ `intent-classifier.ts`, `tools/`) calls the same Mastra server
7. Embedding server: `LLAMA_EMBEDDING_URL` / `AI_EMBEDDING_BASE_URL`; falls back to hash-based embeddings when unavailable
8. Embedding dimension: 384 — changing requires re-ingesting all embeddings

### RBAC

Two layers, both stored in the config DB (PostgreSQL):

1. **System-level**: `roles` + `user_roles`. Permission strings: `resource:action` (e.g. `data_source:view`, `nl_query:*`, `*:*`). Helpers in `src/lib/permissions/permissions.ts` — `hasPermission`, `hasResourceAccess`, `filterAccessibleResources`, `requirePermission`
2. **Data-source-level**: `ds_roles`, `ds_user_roles`, `ds_entity_permissions`. Per-table/column access per data source per role. Helpers in `src/lib/permissions/ds-rbac.ts` — `checkEntityAccess`, `getUserAccessibleEntities`. Generated SQL is parsed by `src/lib/mastra/sql-parser.ts` and validated against these before execution

#### Every path that executes SQL gates on `validateQueryAccess`

`/api/sql/execute` used to check that a session existed, that the SQL was a
`SELECT` and that the data source was real — and then run it. It never asked
whether the caller may read the tables the `SELECT` names, so **any signed-in
user could read every table of any data source they could name**, whatever their
`ds_entity_permissions` said. Both the SQL-editor path and the NL-query path now
gate on `validateQueryAccess` (`src/lib/permissions/query-access-validator.ts`),
and a denial is a 403 naming the tables rather than a blank refusal.

**The heading was aspirational until recently — four paths did not.** A security
review found that the report, chart, export and saved-query routes each resolved
a definition by id and ran its SQL behind a session check alone, so any signed-in
user could read any report's data by naming its id. Those four go through
`decideQueryRun` (`src/lib/permissions/runnable-query.ts`) now, which asks both
questions — is this one read-only statement, and may this caller read the tables
it names — in one place.

**Reach for that module when adding a path that runs stored SQL.** The check was
never missing; reaching it was left to each route to remember, and four of them
did not. Both questions are asked at run time rather than trusted from save
time: `sql_content` is an ordinary column, rows predate the validation, and the
person running a query is frequently not the person who saved it.

Two related things the same review changed:

- `validateQueryAccess` **denies** a query whose tables it cannot determine. It
  used to allow one, and the extractor behind it was a regular expression, so
  `SELECT * FROM(hr_salaries)` — one space removed — named no tables and was
  therefore trusted. Table extraction is a real parse now
  (`extractTablesStrict`), but the inversion is the fix: an access decision that
  cannot be made is a refusal.
- `isReadOnlyQuery` refuses a statement break as well as a leading keyword.
  `SELECT 1 LIMIT 1; DROP TABLE users` used to pass.

That this went unseen for so long has a specific cause worth remembering:
**nothing had ever created a `ds_entity_permissions` row**, so there was nothing
for a check to enforce and no way to notice one was missing. Seeding roles from a
model's `%%rbac` produced the first rows, and with them the real behaviour.

QA found *why* nothing could create one, and it was two things, both fixed: the
Data Source Permissions screen called `/api/data-sources/:id/roles`, `/user-roles`
and `/entity-permissions`, **none of which existed** (they are in
`src/routes/api/data-sources/$id/` now, behind `data_source:edit`); and
`upsertDsEntityPermission` was `INSERT … ON CONFLICT (…)` with **no unique index** on
those columns, so Postgres refused every call. It is update-then-insert now, and
bootstrap adds a unique index with `NULLS NOT DISTINCT` (`entity_schema` is nullable and
almost always NULL; that is Postgres 15+, and the function does not depend on the index).
The tables have no foreign keys, so `deleteDsRole` removes the role's assignments and
permissions itself.

#### Who may do what — three guards, one rule each

QA, probing as the lowest-privileged account (`nlquery`: `nl_query:*` and nothing else),
found it could delete an administrator's report, read every saved query's SQL and the audit
log, read every data source's **decrypted password**, and register a connection to
`169.254.169.254`. Each route checked that a session existed and nothing more. The checks
now live in three small modules, and a new route should reach for one rather than write its own:

| Module | Asks |
|---|---|
| `permissions/resource-guard.ts` | `refuseWithoutPermission(user, "report", "delete")` — does the **role** grant it (the seeded roles already distinguish Viewer, Analyst, NLQueryUser); and `refuseUnlessOwnerOrAdmin` — for a *change*, is the row the caller's own, or is the caller an administrator |
| `permissions/data-source-guard.ts` | `data_source:create`/`edit`, and `refuseForbiddenTarget` — the SSRF host check `/test` always had, now also on create and update |
| `permissions/ds-rbac-api.ts` | everything the `…/roles`, `…/user-roles`, `…/entity-permissions` routes need: the caller, `data_source:edit`, the data source exists |

Rules that came out of it: **never return `connection_config`** from a data-source route
(`getById` is called without `includeConfig`; the list and `active` routes omit the column);
a missing row on update or delete is a **404**, not a silent 200; and a role id or permission
id in a URL is checked against the data source in the same URL.

Also gated, from the second QA pass: `POST /api/jobs` takes `job:create` **or** `job:execute` (the
Analyst holds the latter), validates `job_type`, checks `target_id` names a real report, chart or saved
query, and audits; `GET /api/filters` and `GET /api/reports/:id/filters` (which returns each filter's
`filter_query` SQL) need filter, report or chart view. `POST /api/logs` stays open to any signed-in
user — the browser logger needs it — but is bounded (`src/lib/logging/client-log.ts`: level, 4 000-char
message, identifier-shaped component, 8 KB metadata, 60 entries a minute per user), stamped
`metadata.source = "client"` so it cannot pass for a server log, and takes the user id from the
session. `json(data, { headers })` **replaces** the default `content-type` header — pass it too.

Two rules follow from the fix:

- **`checkEntityAccess` is the one implementation.** `sql-ast-validator.ts` used
  to answer "may this user read this table" itself, against
  `permission_level in ("read", "write", "admin")` — a set **disjoint** from the
  `select | insert | update | delete | all` that the type declares, the
  permissions screen offers and `upsertDsEntityPermission` writes. Both of its
  functions delegate now. Do not add a third reading of that fact; the system-admin
  bypass (`admin:*`) and the column restrictions live in `checkEntityAccess` only.
- **The translator refuses rather than warning.** Both call sites used to log the
  verdict and return the SQL anyway. On the voice path nothing executed, but SQL
  naming forbidden tables went back to the speaker — which discloses the schema
  and somebody else's permissions just as well as running it would. The refusal
  has its own shape rather than being folded into `null`, because "you may not
  read `bus_account`" and "the model could not write a query" are different
  things to tell somebody and `null` already meant the second.

### Intelligent UI — views over one access-checked result

`/intelligent-ui` (`src/routes/_authed/intelligent-ui/`, linked from the sidebar next to
NL Query) lets the assistant present the result of an NL-generated query as a table,
chart or KPI. It adds no way to reach data: SQL is generated the way NL Query generates
it and goes through the same `/api/nl-query/execute` → `executeNlQueryPipeline` →
entity-level RBAC, so a denial there is a denial here.

- **The model sees the shape of a result, never its rows.** `runQuestion` returns column
  names, kinds and a row count. The rows stay in the browser.
- **The model emits a spec, not markup or code.** `src/lib/intelligent-ui/spec.ts`
  (`validateSpec`) refuses any column the result does not have, an aggregation the column
  type cannot support, and a limit above `MAX_VIEW_ROWS`.
- **Every figure is computed by `applySpec`** (`apply-spec.ts`), a pure function over the
  returned rows. Do not add a path where model text supplies a number.
- Charts and tables reuse `NlResultsChart` / `NlResultsTable`; there is no generated
  HTML/JS and so no sandbox. If one is ever added, it needs the network restrictions that
  design currently avoids.
- **Excel export** (`POST /api/intelligent-ui/export`, `export-xlsx.ts`) is laid out like the
  report generator's workbooks: a Summary sheet (question, SQL, who, when), one sheet per
  view with the chart picture above its table (`renderChartPng` in
  `src/lib/report-generation/chart-image.ts`, shared with the report worker), and a Data
  sheet with the full result. **The request carries the question, SQL and view specs —
  never rows.** The server re-runs the query through `executeNlQueryPipeline` (so the
  entity checks apply to the file exactly as they do to the page), re-validates every view
  and rebuilds the workbook with `applySpec`. Accepting rows from the browser would let
  anyone mint a "report" with numbers of their choosing. The file therefore reflects the
  data now, not the page as it was left. Exports are audit-logged (`export` / `query`).

**`executeNlQueryPipeline` refuses anything that is not one read-only statement.** Entity
access says *which tables a user may read*; it says nothing about writing them, and the
pipeline never asked. Through `/api/nl-query/execute` — so the NL page, the Intelligent UI and
its Excel export — an `INSERT`, or `UPDATE …; SELECT 1`, ran as written (the appended `LIMIT`
only broke statements that did not end in a `SELECT`). Refusals are audit-logged, and so are
successful runs, as the SQL editor's are. `src/lib/mastra/__tests__/nl-query-pipeline-readonly.test.ts`
fails without the check.

**`/api/nl-query/execute` runs the SQL it is given and generates none.** A request without
`generated_sql` is a 400 `SQL_REQUIRED`; it used to run `SELECT 1;` in its place, which
returned a successful-looking one-row result for a question nothing had answered. The
route's errors are `{ success: false, error: { code, message } }` throughout, and
`generatedSql` is required in `executeNlQuery` and `useExecuteNlQuery` so a caller that
forgets it fails to compile.

### The chat assistant — delegated sign-in, search, embed and chat-only (`src/lib/chat/`)

The orchestrator can put a chat assistant (`assistant/` there, open-source CopilotKit) in front of this
platform and the generated application. A person signs in once, to the application; the assistant then
asks this platform for a session for them. All of it is **off unless `CHAT_BRIDGE_SECRET` (≥ 32
characters) is set**, and framing is off unless `CHAT_EMBED=1`.

- **`POST /api/chat/delegate`** takes a statement signed with that secret (`statement.ts`: audience
  `report-delegate`, 60 seconds, single use — `ReplayGuard`). It is not under `/api/auth/`, which is
  Better Auth's. `delegate.ts` creates the person on first use (no password, so they cannot sign in
  directly) and **re-syncs** `user_roles` and `ds_user_roles` to the roles whose names match their
  application roles (`roleKey`: `sales_manager` = `Sales Manager`). A deactivated user is refused.
- **An account that has a password of its own is never re-synced.** It is a local account, managed
  here: re-syncing stripped the Administrator role from a platform administrator whose application
  account was ordinary (a reviewer caught it). The assistant signs in as such an account only for an
  application administrator — `admin@admin.com`, which both sides create — and is refused otherwise.
- **Administrator comes from the application's verdict (`admin: true`) and never from a name.**
  `resource-guard.ts` reads any role whose name *contains* "admin" as an administrator, so a matched
  role with such a name ("Administrator (model role)", "Office Administrator") is skipped. Do not
  loosen `isPlatformAdminName` without changing that check first.
- **The session cookie is written by hand** (`session-cookie.ts`), in Better Auth's own format, because
  the session is created through its adapter rather than its sign-in endpoint. It was checked against a
  running instance: the cookie is accepted, a tampered one is a 401.
- **`GET /api/search?q=`** returns reports, charts, dashboards and saved queries by name, each kind only
  when the caller's role grants its `:view`. Names and ids only — never SQL, never data.
- **Embed mode** (`AppShell`): inside a frame the sidebar and header are left out. With `CHAT_EMBED=1`
  `src/server.ts` sends `frame-ancestors 'self'` / `SAMEORIGIN`; without it, `'none'` / `DENY` as before.
- **Chat-only mode** (`chat-only.ts`, called from `src/server.ts`): when the administrator's switch
  (relayed by the assistant at `CHAT_SWITCHES_URL`) is on, a non-administrator's page load is served
  only inside the frame with a genuine `chat_embed` cookie issued to them; otherwise it is redirected
  to `CHAT_URL` (default `/chat/`). It is a lock on *where people work*, not what protects data —
  `decideQueryRun` still does that — and it fails open when the assistant cannot be asked.

### Sharing — between the people who use the system first

A share link (`/share/{dashboard,chart,report}/:id`) resolves through `resolveShareFn`
(`src/server-fns/share.ts`): signed in **and** the role may view that kind of thing → redirected
to the real page; otherwise, if the owner made it public → the limited public page (a name, no
data); otherwise one "not available" answer, the same whether the item is private or does not
exist. The Share dialog always shows the link. `PATCH /api/dashboards/:id` and `/api/charts/:id`
set `is_public` (they did not exist, so the dialog's toggle fell through to the HTML shell and a
200). An anonymous visitor is offered **Sign in**, which returns to the link via
`/login?redirect=…`; `safeRedirectTarget` accepts only a path on this site.

### Datasets — a saved query the browser loads into DuckDB

`/datasets` (needs `NEXT_PUBLIC_WASM_ENABLED=true`) lists datasets and loads them into
DuckDB-WASM. A dataset is a row in `datasets` pointing at a saved query — **no data is stored on the
server**. `GET /api/datasets/:id/data` runs the query for whoever is downloading, through
`decideQueryRun` (so entity permissions apply to the download exactly as to the SQL editor), caps it at
`DATASET_MAX_ROWS` (100 000; `x-dataset-truncated` says when it bit) and returns an **Arrow IPC
stream**, not Parquet — the page never read Parquet, and `read_parquet` would reject it. Creating
a dataset runs the same check, so nobody saves one they could not download.

- The driver returns `numeric` and `count(*)` as strings; `coerceNumericColumns` turns a column of
  plain numbers (no leading zeros, exactly representable) into numbers so DuckDB can `SUM` it.
  There are no column types to go by, so a text column of digits-only values is converted too.
- Nothing is cached in IndexedDB: the rows were produced under the caller's permissions at that
  moment. Earlier builds did cache them (`parquet_<id>`), so `purgeDatasetCache()` deletes any left
  behind when the Datasets page opens and on sign-out. `useDatasetEnhanced`, which served that cache
  back without asking the server, is deleted. Do not reintroduce an offline copy of query results
  without tying it to the user and to a permission check.
- `src/lib/export/source-connector.ts` and `parquet-exporter.ts` are gone. The first ran caller-supplied
  SQL against the **config** database. Do not recreate it; run SQL through `getConnection` and `decideQueryRun`.
- Three defects had made every WASM feature unreachable, found by loading a dataset in a browser:
  the `NEXT_PUBLIC_*` flags never reached the client bundle (hydration mismatch, page always "not
  enabled"); DuckDB's bundles came from jsDelivr, which a browser refuses as a Worker script
  ("cannot be accessed from origin") so it never started; and a loaded dataset showed 0 B because
  the transferred buffer's `byteLength` was read after the transfer.

### Email templates — `/api/email-templates`

The Email Templates page and editor were written against an API that did not exist, so the page
showed an error. The routes are `src/routes/api/email-templates/` (list/create, get/update/delete,
`$id/preview`), behind `setting:view` / `setting:edit` (the Administrator role): templates go to whole
recipient lists through the batch email worker, so they are installation configuration.

- **Stored as the worker reads them.** `email_templates` keeps `html_body` (and `body`, NOT NULL, with
  the same HTML — the worker falls back to it) and `column_mappings` as JSON; `query_id` and
  `created_by` are added at bootstrap. `src/lib/email/templates.ts` converts rows to the camelCase
  `EmailTemplate` the UI uses.
- **The preview renders what would be sent**: the same `renderTemplate`, the same placeholder→column
  rule as `email-batch-worker.ts` (`variablesForRow`), against the first five rows of the template's
  query — which runs through `decideQueryRun`. It also lists placeholders with no mapping; those are
  left visible as `{{name}}`, as they would be in a sent email.
- **`renderTemplate` escapes values in an HTML body** (not in the plain-text subject). It used to insert
  them raw, so a value in a database row became live markup in every email sent from it. Replacements
  are functions, because `String.replace` reads `$&` in a replacement string.

### Background Jobs — Trigger.dev, not BullMQ

Job processing runs on **Trigger.dev** (`@trigger.dev/sdk`), configured in `trigger.config.ts` (project `enterprise-reporting`, tasks discovered under `./src/lib/jobs`).

- Task definitions: `src/lib/jobs/trigger-tasks.ts` — `report:generate`, `data:export`, `email:batch`, `scheduled:refresh`, plus monitoring evaluation
- Enqueue via `src/lib/jobs/trigger-queue.ts`; the actual work lives in `src/lib/jobs/workers/`
- `src/lib/jobs/worker-runner.ts` picks the backend: Trigger.dev when `TRIGGER_API_URL` is set, otherwise it starts the built-in on-premise cron runner (`src/lib/monitoring/monitoring-scheduler.ts`), a pure-Bun interval loop that polls `monitoring_rules` every minute
- **BullMQ is gone.** `src/lib/queue/` — the dead legacy tree that imported `bullmq` and `ioredis`, neither of which was ever in `package.json` — has been deleted, along with the Bull Board routes it backed. Job payload types now live beside their consumers in `src/lib/jobs/types.ts`, and the workers take their payload directly rather than a BullMQ `Job` wrapper. `/bull-board` is `/trigger-board`

#### Job definitions — created, scheduled and run

A row in `job_definitions` is a scheduled job, and `src/lib/jobs/job-definition-runner.ts` is what
runs it. Until the second QA pass nothing read those rows: a job created with a cron expression
never fired, and the only two creators (assistant actions) posted a body the route rejected.

- **Vocabulary:** `job_type` is `report` (target: a report definition) or `export` (target: a saved
  query) — the two with a worker (`job-vocabulary.ts`). `chart` is typed elsewhere and has no worker, so
  it is refused. `parameters.format` is `csv` (default), `xlsx` or `pdf`. Types the runner does not own
  (`monitoring:evaluate`, written by `rule-persist-tool.ts`) are left to whatever wrote them.
- **Creating:** `POST /api/jobs` validates the body (`job-input.ts`; `schedule_cron` must pass
  `isValidCron`, because the matcher treats anything it cannot parse as "never" and a job saved with
  "every monday" would silently never run), and the caller must pass `decideQueryRun` on the target's
  SQL. The assistant action is defined once in `create-job-client.ts` (`CREATE_JOB_ACTION`,
  `createJobByName`) and takes the target's *name*, resolved by `GET /api/jobs/targets`.
- **Running:** UTC, five-field cron (`cron.ts`), polled every 20 s, started by `initializeWorkers()` in
  **both** modes — Trigger.dev does not schedule these either. Each (job, minute) is claimed by one
  `INSERT` against a unique index on `job_executions(job_definition_id, scheduled_for)`, so polling
  twice a minute, a restart, or a second process cannot run it twice. Every outcome is a
  `job_executions` row (`completed` with the file and row count, or `failed` with the reason).
- **As the creator, with today's access.** The workers call `refuseJobQuery` (`permissions/actor.ts`),
  which rebuilds the creator's `SessionUser` and asks `decideQueryRun`. The report, export and
  email-batch workers ran stored SQL with **no** access check — the one family of paths the "every path
  that executes SQL gates on `validateQueryAccess`" rule did not reach, because they have no session.
  A creator who has since lost a table, or been deactivated, gets a failed execution and no file. Do not
  run stored SQL in a worker without it.
- **Results:** `GET /api/jobs/:executionId/result` serves the file to the job's owner or an
  administrator only, and only from inside `JOB_OUTPUT_DIR` (`output-dir.ts`; the stored path is a text
  column, so it is checked, not trusted). There is no Cancel: an in-process run cannot be interrupted.
- `mock.module` in `bun:test` is **process-wide**. The runner takes its collaborators as arguments so
  its test needs none; a mock in one file silently replaces the module for every other.

### Other Subsystems

- **DuckDB WASM** (`src/lib/duckdb/`, `DuckDBProvider` in the root layout): in-browser SQL over query results, gated by `NEXT_PUBLIC_WASM_ENABLED`; progressive loading in `src/lib/wasm/`
- **Knowledge graph** (`src/lib/graph/`): Apache AGE schema sync + graph RAG for NL context
- **Metadata layer** (`src/lib/metadata/`): entity/field definitions, sync from live data source schemas, and metadata-level permissions
- **OpenKB** (`src/lib/openkb/`): knowledge-base client + embedding service for help content
- **Export** (`src/lib/export/`): CSV, Excel via `exceljs`, PDF via `jspdf` + `jspdf-autotable`
- **Logging** (`src/lib/logging/`): Pino; logs are also persisted to the config DB `logs` table
- **Voice** (`src/lib/voice/`, `/api/voice/ws`): Qwen ASR and TTS clients over the llama.cpp endpoints, for spoken NL queries
- **ADK pipeline** (`src/lib/adk/`): the agent/tool orchestration variant of NL query — `intent-classifier.ts`, `pipeline.ts` and `tools/`, against the same Mastra server
- **Report generation** (`src/lib/report-generation/`): the worker that renders report definitions into stored artifacts, plus its cleanup job
- **Record links** (`src/lib/reporting/record-link.ts`): opening a report row as a record in another application — see its own section below

### Help is one toaster, and `HelpProvider` renders it

`src/components/help/help-toaster.tsx` is the only help surface. A `?` opens a
panel pinned to the top right; **its own close button is the only way out** — no
timeout, no click-outside, no Escape, no backdrop and no focus trap, so the
query, report or chart being explained stays visible and editable beside it. One
panel at a time.

`HelpProvider` is the **innermost** provider in `__root.tsx`, and both facts
about its position are load-bearing: it is inside `QueryClientProvider` because
the articles are a `useQuery`, and it renders the toaster itself so that no
screen places a help surface of its own. A `?` anywhere below it opens the one
panel.

- `HelpButton.tsx` — the masthead `?`. It used to advertise "press ? for
  keyboard shortcut"; nothing listens for `?`, and a global binding would fire
  while someone typed a question mark into the SQL editor.
- `HelpPanel.tsx` — the three views (search, an 18-category `<select>`, an
  article) at 26rem. The rail is a `<select>` because eighteen buttons do not fit
  beside anything; the articles, the search and the `DOMPurify` sanitising are
  unchanged from the dialog it replaced.
- `HelpTopicButton` — a `?` for one piece of inline help, named that way rather
  than `HelpButton` to avoid clashing with the masthead component. The cron
  reference on the jobs screen uses it; it was a hover `Tooltip`, available only
  on a pointer, after a delay, and never on a touch device.

**`top-20`, not `top-4`.** The header's right-hand end carries the theme
selector, this `?`, the notification bell and the account menu — a non-modal
panel must not be the thing making four of its own controls unclickable.

This matches the generated application deliberately: `/app` and `/report` come
up together and its dashboard links straight into this platform, so a reader who
meets both should not have to learn two ways to ask for help.

### TanStack DB (client-side state)

`src/lib/tanstack-db/collections.ts` — local in-memory `@tanstack/db` collections (no server sync configured):
`activeFiltersCollection`, `chartDraftCollection`, `dashboardStateCollection`, `queryHistoryCollection`, `reportsCollection`, `chartsCollection`, `dashboardsCollection`

### Feature Flags

`src/lib/feature-flags.ts` reads `NEXT_PUBLIC_*` env vars (naming is a leftover; this is not Next.js):
- `NEXT_PUBLIC_WASM_ENABLED` — DuckDB WASM in-browser SQL
- `NEXT_PUBLIC_ECHARTS_ENABLED` — ECharts alternative to Recharts
- `NEXT_PUBLIC_CROSSFILTER_ENABLED` — cross-widget dashboard filtering
- `NEXT_PUBLIC_OFFLINE_ENABLED` — the online/offline badge on dashboards (there is no offline data cache)
- `NEXT_PUBLIC_PROGRESSIVE_ENABLED` — progressive loading for large datasets

**The flags are substituted at build time** (`featureFlagDefines` in `vite.config.ts`), in the client
and the server bundle alike. Vite does not put `process.env` in the browser bundle, so they used to be
read as unset there while the server saw them set. The value is what the environment (or `.env`) holds
when `vite dev` / `vite build` runs: a Docker build needs them as build arguments, and changing one
means rebuilding. Other `NEXT_PUBLIC_` variables are *not* substituted — the server reads them at run time.

## Environment Variables

**Required:**
```
AUTH_SECRET=           # Better Auth secret (≥32 chars; the app refuses to boot below that)
ENCRYPTION_KEY=        # AES-256-GCM key (64 hex chars) for data source connection configs
DATABASE_URL=postgresql://enterprise:password@localhost:5432/enterprise_config
GRAPH_DATABASE_URL=postgresql://enterprise:password@localhost:5432/ers_knowledge
```

**AI / NL Query (optional, needed for NL features):**
```
MASTRA_URL=http://localhost:4111           # Mastra AI server
LLAMA_REASONING_URL=http://localhost:8080  # llama.cpp NL→SQL (appends /v1)
AI_NL2SQL_BASE_URL=                        # Full base URL override (includes /v1)
AI_NL2SQL_MODEL=                           # NL→SQL model name
LLAMA_EMBEDDING_URL=http://localhost:8080  # Embedding server
AI_EMBEDDING_BASE_URL=                     # Full embedding URL override
LLAMA_STT_URL=http://localhost:8081        # Speech-to-text
LLAMA_TTS_URL=http://localhost:8083        # Text-to-speech
```

**Optional:**
```
BETTER_AUTH_URL=           # Better Auth baseURL; falls back to APP_URL, then http://localhost:4050
APP_URL=http://localhost:4050
CORS_ORIGIN=               # comma-separated; appended to Better Auth's trustedOrigins
TRIGGER_API_URL=           # Trigger.dev server; unset falls back to the built-in cron runner
TRIGGER_API_KEY=
WORKER_CONCURRENCY=5
SMTP_HOST/PORT/USER/PASS/SECURE  # Email settings
LOG_LEVEL=info             # Pino log level
DEFAULT_PAGE_SIZE / MAX_PAGE_SIZE / DATA_TABLE_PAGE_SIZE / EXPORT_PAGE_SIZE
```

`.env.example` documents most of this set; copy it to `.env` to start. Two gaps to
know about: it still describes `AUTH_SECRET` as a "JWT signing key", which it has
not been since the Better Auth migration, and it does not mention `BETTER_AUTH_URL`
or `CORS_ORIGIN` at all — both are read by `src/lib/auth/better-auth.ts`, and
getting `baseURL` wrong behind a reverse proxy is a sign-in that redirects to the
wrong origin.

**Server-side pagination is mandatory.** Every data query must apply `LIMIT`/`OFFSET` at the database level; never fetch a full table and paginate on the client. This is a rule with a recent counter-example: `/api/queries` selected the whole `saved_queries` table — every row and every row's `sql_content` — and reported `meta.total` as the length of what it had already fetched, while the caller asked for a page. Filtering in the browser has the matching defect: it only ever searches the rows that page happened to contain, so a query whose name matches is invisible unless it landed on the page you were looking at. Both are done at the database now; do the same for any new list endpoint.

## Default Credentials

Auto-created by `bootstrapSchema()` on first startup (the admin only when no
users exist; the nlquery account only when that row is absent):

- `admin@admin.com` — full administrator. Password from `ADMIN_PASSWORD`.
- `nlquery@nlquery.com` — NL query role only. Password from `NLQUERY_PASSWORD`.

**Neither password is compiled in any more.** Both used to be pre-computed
bcrypt hashes of the words `admin` and `nlquery`, sitting in `bootstrap.ts` —
so every installation that had not changed them, and nothing prompted anyone
to, could be signed into by anyone who had read this repository. With the
environment variable unset a random password is generated, printed once at
boot, and stored nowhere it can be read back.

The credential endpoints are rate-limited now too (`rateLimit` in
`src/lib/auth/better-auth.ts`: 5 sign-ins per minute). Nothing throttled
anything before, so a weak password was guessable at whatever rate the network
allowed.

Running `bun run db:seed` also adds `analyst@example.com` / `analyst123` with a sample Sakila data source.

`bootstrapSchema()` also backfills `auth_accounts` from `users.password_hash` for
every user that has no `credential` account yet, which is what lets these
(and any pre-migration account) sign in through Better Auth unchanged.

## Dependencies — 78, and the ones that look unused are not

22 packages that nothing imported were removed (99 → 78 dependencies, 18 → 17 dev).
Gone: 11 unused `@radix-ui/react-*` primitives, `antlr4` (the SQL parser uses
`antlr4ng`), `idb` (the offline cache uses `idb-keyval`), `sqlite`, `sql.js` and
`@vscode/sqlite3` (SQLite is not a supported data source), `parquet-wasm`
(`parquet-exporter.ts` writes Arrow IPC), `pino-http`, `date-fns`, `lodash`,
`@types/lodash` and `@tanstack/react-store`.

**Six survive a grep for their own name and must not be "cleaned up":**
`postcss` and `autoprefixer` (plugin keys in `postcss.config.js`),
`tailwindcss-animate` (required in `tailwind.config.ts`), `pino-pretty`
(`transport.target`, loaded by name at runtime), `typescript`, and the remaining
`@types/*`. Two more are single-consumer and easy to mistake for dead weight:
`redis` is imported only by `src/lib/openkb/openkb-client.ts`, and `better-sqlite3`
is Mastra's.

**A passing build does not prove a dependency is unused.** Bun keeps a removed
direct dependency resolvable as long as something else still depends on it, so the
evidence has to be the absence of any module specifier in the source, with the
build as confirmation rather than as the argument.

## The reporting-pack seeder — `scripts/seed-reporting-pack.ts`

This 873-line script loads a **generated application** into this platform. It runs
once, after both databases are up, and leaves the platform holding a working
analytics workspace for whatever application was just generated:

1. the generated application's database, registered as a data source with its
   connection details encrypted the way this platform expects
2. that database's schema, introspected and cached — which is what the NL-query
   pipeline reads as context and what the data-source screens list as entities
3. every saved query, report, chart, dashboard and widget in the *reporting pack*
   derived from the model

```bash
REPORTING_PACK=<pack.json> APP_DATABASE_URL=<app db url> bun scripts/seed-reporting-pack.ts
```

It writes **eleven** of this schema's tables and is **idempotent by name**: run it
twice and the second run updates in place. That matters because it runs on every
`docker compose up`, not only the first.

**It lives here rather than in the orchestrator, and that is the point.** It was
written in `app-and-report-with-ai-tanstack`, where docker-compose stands this
platform up beside a generated application, and was *copied into this tree at image
build time* so it could import through `@/`. That is the right dependency in the
wrong direction: the file needs this project's real `getDb`, `encrypt` and
`introspectAndCacheSchema`, and a seeder with its own encryption or its own
schema-cache shape drifts from the reader — the failure looks like a data source
that exists and cannot be opened. There are now three callers (the orchestrator's
compose file, a generated application's own compose file, and a direct run), and
all three run *this* file rather than a copy.

It hashes with `bcryptjs`, deliberately — the same algorithm `better-auth.ts`
keeps. A seeder hashing with anything else writes accounts that cannot sign in,
and the failure reads as a wrong password.

**A pack is derived, never invented.** `buildReportingPack` in
`app-with-ai-tanstack` (`packages/generator/src/reporting/pack.ts`) builds it from
the model: every query comes from something the model declares, and every reporting
role mirrors a `%%rbac` role's `read` rules. This file only writes it down.

## Record links — `src/lib/reporting/record-link.ts`

A report definition may carry a record link, and the read-only record view then
grows a button that opens the same record in another application — the generated
application it was reported on, or anything else that can address a record by id.
`{id}` in the template is replaced with the row's id, URL-encoded.

**The scheme is allow-listed in one place, and both ends go through it.** The URL
is supplied by an administrator and ends up in an `href`, which is an injection
sink: `javascript:alert(1)` runs on click. An administrator is trusted, but that is
not the same as being able to store a payload that fires for every *ordinary*
viewer of the report. Site-relative (`/app/bus_account/{id}`) and absolute
`http:`/`https:` are permitted and nothing else — an allowlist rather than a
denylist of `javascript:` and friends, because a denylist has to anticipate every
scheme a browser will ever honour and is wrong in the unsafe direction.

## Testing

### Unit tests — run by `bun run test`, by `precommit`, and by CI

Four `bun:test` files existed; ten more were added by QA (the guards, the NL read-only check, the
Intelligent UI engine and export, share redirects, id schemas, and a static test that no route reads
a request body inside a `catch`). The original four:

| File | Covers |
|---|---|
| `src/lib/reporting/__tests__/record-link.test.ts` | template validation and URL building |
| `src/lib/sql/__tests__/validator.test.ts` | the SQL validator |
| `src/lib/sql/__tests__/antlr-validator.test.ts` | the antlr4ng validator |
| `src/lib/validation/__tests__/translation-validator.test.ts` | translation validation |

Two things to know before you trust them:

- **`bun run test` is the one command** (`bun test src`), and `precommit` and the CI **Unit tests**
  job both run it. They were run by neither until three assertions had been red for a while without
  anyone noticing. A failing test is a failing check now; do not skip or delete one to get green —
  decide whether the code or the test is wrong, as was done below.
- **They need no `.env`.** `bunfig.toml` preloads `src/test-setup.ts`, which supplies a throwaway
  `AUTH_SECRET` when none is set (`better-auth.ts` throws at import without one). Without it, three files
  passed on a developer machine and errored on a fresh checkout. Check a change on a clean worktree
  with `env -u AUTH_SECRET bun test src`.
- **Run them as `bun test src`, not `bun test`.** A bare `bun test` also collects
  the ~51 Playwright specs under `e2e/`, which are written against
  `@playwright/test` and error out under Bun's runner — 51 errors that say nothing
  about the code.

`bun run test` is 238 pass / 0 fail across 23 files. Three of the original `validator.test.ts` assertions
had been red, and each was decided on its merits rather than silenced:

- `SELECT * FROM users;` expecting **zero warnings** was a stale test. The validator warns on `SELECT *`
  and on a missing `LIMIT` on purpose, and the editor's validation panel shows them; the test now asserts
  exactly those two, plus that a query with named columns and a `LIMIT` has none.
- `SELECT * WHERE id = 1;` and the empty string reported `isValid: true` because `node-sql-parser` is
  syntactic and parses an empty query as zero statements. That was the validator being too permissive:
  `validateSQL` now reports "Query is empty" (blank text, a comment, a bare `;`) and "SELECT * requires a
  FROM clause" (a star in a select list with no FROM, anywhere in the tree, so a subquery counts).
  `SELECT 1` and `SELECT COUNT(*)` still need no FROM. Execution is gated by `isReadOnlyQuery`, a
  different function, which these changes do not touch.

### E2E tests

Playwright tests in `e2e/`. The dev server must be running on port 4050 before running tests (the `webServer` config in `playwright.config.ts` is commented out). Auth state is set up once by `e2e/global-setup.ts` and cached in `auth.json`, then reused via `storageState`. Tests run serially (1 worker, `fullyParallel: false`) to prevent session interference. Override the target with `BASE_URL`.

`global-setup.ts` signs in by driving the real login form as
`admin@admin.com` with `E2E_ADMIN_PASSWORD` (default `admin`), so it exercises Better Auth end to end rather than
forging a cookie — which also means a broken `/api/auth/$` route fails the whole
suite at setup rather than one spec at a time. **CI does not run this suite**: it
needs the dev server, a PostgreSQL config database and a cached session, and
nothing starts those for it. See **CI** below.

**`admin` / `admin` cannot exist on a fresh install.** The bootstrap ignores a password under
8 characters and generates a random one, so a suite expecting `admin` fails at setup against any
database created since. Set `ADMIN_PASSWORD` (≥ 8) when the database is created and the same value as
`E2E_ADMIN_PASSWORD` when the suite runs; `e2e/SETUP.md` has the commands. `scripts/rebuild-db.ts` now
drops the Better Auth tables too — it did not, so a rebuilt database handed the fixed-id admin the
*previous* run's credential and the configured password was rejected.

## `bun run typecheck` passes — keep it that way

`tsconfig.json` includes `**/*.ts`, so `typecheck` — and therefore `precommit` —
covers `language/`, `scripts/`, `e2e/` and `tests/` as well as `src/`. It now
reports **zero** errors.

It did not always. The backlog was 678 errors across ~140 files, and it was
invisible: a single unescaped backtick in `language/cli/src/generate/app.ts`
made that file unparseable, and one parse error makes `tsc` report *that alone*
and stop — so `typecheck` printed exactly one error and exited 2, which reads
far more like a small local problem than a backlog. Fixing the parse error is
what surfaced the rest.

Two habits are worth keeping from that:

- **A low error count is not automatically good news.** If the number collapses
  after an edit, check for a parse error stopping `tsc` early rather than
  assuming you fixed something.
- **Most of those 678 were real defects, not type noise** — Kysely called with
  Knex's API, `.where(column, value)` without an operator, server functions
  reading their payload off the ctx, inserts omitting a NOT NULL primary key,
  columns and hooks that never existed. Treat a new error as a bug report.

`language/**` uses explicit `.ts` import specifiers, which Bun resolves and
`tsc` rejects (TS5097) unless `allowImportingTsExtensions` is set — it is, in
`tsconfig.json`, and it needs the `noEmit` that is already there.

## `bun run precommit` — the type-check and the unit tests

`precommit` is `bun run typecheck && bun run test`. The first is **`bun check`** — the type checker
built into Bun since 1.4.3. It reads `tsconfig.json`, reports the same errors as
`tsc`, and runs on every core: about 6 seconds here against 35 for `tsc --noEmit`.
It reports zero errors. `typescript` stays a dev dependency for editors; nothing
in a script runs `tsc` any more.

One difference from the `tsc` 5.x this tree used to run, and it is why
`src/vite-env.d.ts` exists: `bun check` reports a side-effect import it cannot
resolve (TS2882), as newer TypeScript does by default, so the fourteen
`import "….css"` lines failed until `vite/client`'s declarations were
referenced. Do not delete that file to make an error go away elsewhere.

**There is no linter and no formatter.** Biome was removed outright — its config,
its dependency, its scripts, its CI steps and its suppression comments — and Bun
has neither tool, so nothing checks style or layout. The type-checker is the
whole static check. That was a choice, and it has a cost worth knowing: the
rules Biome enforced as errors (`noArrayIndexKey`, `useConst`, `useTemplate`,
`noImplicitAnyLet`) are no longer enforced by anything, and code is formatted by
whoever's editor last touched it. Keep the existing style — 2 spaces, double
quotes, semicolons, ES5 trailing commas, 100 columns — by hand.

The suppression comments kept their reasons. `// biome-ignore lint/…: <reason>`
became `// <reason>` — why an `any`, an index key or a `dangerouslySetInnerHTML`
is acceptable at that spot is still worth reading, even with nothing enforcing
the rule it once excused.

**`precommit` runs the unit tests (about 3 s) but not Playwright.** See **Testing**.

**`src/routeTree.gen.ts` is written by the TanStack router generator on every
`vite build`.** Do not edit it by hand; the generator wins, and CI fails a build
that leaves it modified.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`.
Before it existed — which was until recently — nothing on GitHub checked
anything here, and `precommit` passing was only ever true of whichever tree
someone last ran it in.

| Job | What it runs |
|---|---|
| **Types** | `bun install --frozen-lockfile`, then `bun run typecheck` (`bun check`) |
| **Unit tests** | `bun install --frozen-lockfile`, then `bun run test` (`bun test src`). No database and no secrets: the tests stub what they touch and `bunfig.toml` preloads a throwaway `AUTH_SECRET` |
| **Build** | `bun --bun vite build`, then an assertion that the build left no tracked file modified — the router generator rewrites `routeTree.gen.ts` on every build, and a diff means a route was added without regenerating or the file was edited by hand |

Whether **Unit tests** is a *required* status is a branch-protection setting in GitHub, not something
this repository can set; until it is required, a red run is visible but does not block a merge.

Two more things it deliberately does not do. There is **no `paths:` filter**:
`tsconfig.json` includes `**/*.ts`, so typecheck covers `language/`, `scripts/`,
`e2e/` and `tests/` too, and any filter narrow enough to be useful would leave
one of them unguarded — a skipped path-filtered run also reports no status at
all, which makes a job awkward to require later. And it **does not run the
Playwright suite**: that needs a dev server on 4050, a PostgreSQL config
database and a cached signed-in session, and `playwright.config.ts` has its
`webServer` commented out, so it starts nothing itself.

Bun is pinned to `1.4.4` there and in `Dockerfile` and `Dockerfile.mastra`;
`package.json` asks for `>=1.4.4`, the first release with `bun check`.

## Stale documentation

Most files under `docs/` predate the migrations to PostgreSQL and Trigger.dev and describe SQLite/MariaDB, BullMQ + Redis, Bull Board, and OpenAI-based NL query. `docs/README.md` and this file are current; verify anything else in `docs/` against source before trusting it.

The ten deployment documents at the repository root (`DEPLOYMENT*.md`,
`HOSTINGER_*.md`, `QUICK_START*.md`, `README_HOSTINGER_DEPLOYMENT.md`) were all
written in June 2026 and none has been revised since — three months before the
Better Auth migration and the `bun run start` fix. Check anything operational in
them against source.

One piece of advice in them is actively dangerous:
`README_HOSTINGER_DEPLOYMENT.md` suggests "rotating `AUTH_SECRET` and
`ENCRYPTION_KEY`" for production. **Rotating `ENCRYPTION_KEY` leaves every stored
data-source connection config undecryptable**, and the failure presents as a broken
data source rather than as a rotated key. Rotating `AUTH_SECRET` invalidates every
live session. Neither is a routine hardening step; generate both once, before the
first boot, and leave them alone.

The same applies to the Docker Compose files: `docker-compose.yml` is current (PostgreSQL via `apache/age:PG16`, `DATABASE_URL`/`GRAPH_DATABASE_URL`), while `docker-compose.dev.yml`, `docker-compose.local.yml`, and `docker-compose.remote.yml` still start a MariaDB container and pass `MARIADB_*` to the app, which ignores them.

## EML Language System

`language/` contains the EML modeling-language system — a Mermaid-based language for describing an application as ERD + business rules + workflows, then generating a complete TanStack Start + Kysely application from that description.

Every EML document is valid, renderable Mermaid (`erDiagram`, `flowchart`, `stateDiagram-v2`). EML is a semantic superset: it assigns generator meaning to standard Mermaid syntax and to `%%` directive comments.

### Key files

- `language/appwithai-language.json` — machine-readable language definition (grammar, directives, validation rules). Renamed from `erdwithai-language.json`; `index.ts` loads it by that name
- `language/checker.ts` — validates an `.mmd` file against the language definition
- `language/fixer.ts` — auto-repairs fixable checker diagnostics in-place
- `language/index.ts` — programmatic API (`loadLanguageDefinition`, `parseEml`, `validateModel`)
- `language/rag.ts` — RAG indexing for EML-aware LLM completions
- `language/cli/eml.ts` — CLI entry point (run with Bun)
- `language/sections.ts` — the one reading of `%%section`, shared by the checker and the fixer
- `language/examples/` — sample EML models (`minimal`, `ecommerce`, `helpdesk`, `crm`, `dance-studio`), every form laid out with `%%section`

The protocol document a language model is pointed at to write or change a model is `llms.md`, published at `https://www.appwithai.org/llms.md`. It is not in this repository.

### Where this copy comes from

The engine here — `checker.ts`, `fixer.ts`, `index.ts`, `composer.ts`, `rag.ts`, `sections.ts`, `browser/`, `grammar/`, `spec/`, the language definition, the examples, and the CLI's `model.ts`, `parser.ts` and `generate/enterprise-reporting.ts` — is a copy of `app-and-report-with-ai-tanstack/common/language/`, which is canonical when the product repositories disagree about the language. It had drifted behind (no line items, no help-text or dictionary-completeness codes, no `%%section`, an `icon` that was still "not compiled"), and was brought level in one change. **Copy, don't edit**, and when the orchestrator's copy moves, copy again; nothing checks one against the other.

What stays specific to this repository: `cli/src/cli.ts` (two stacks, `enterprise-reporting` the default — `tanstack-nestjs` belongs to `app-with-ai-tanstack` and is rejected), `cli/src/generate/jdm.ts` and `cli/src/vendor/` (below), `cli/package.json`, and the README files.

### CLI usage

Input is `-i/--input` or the first positional argument; output is `-o/--output`.
There is no `--out`.

```bash
# Validate a model
bun language/cli/eml.ts validate -i model.mmd

# Inspect parsed model summary
bun language/cli/eml.ts info -i model.mmd

# Generate application (enterprise-reporting is the default stack)
bun language/cli/eml.ts generate -i model.mmd -o ./generated

# Generate the dependency-free Node REST app instead
bun language/cli/eml.ts generate -i model.mmd -o ./generated --stack node-rest

# Auto-fix checker warnings before generating
bun language/checker.ts model.mmd   # check — also writes model.mmd.error beside it
bun language/fixer.ts model.mmd     # fix in-place
```

**The two stacks are `enterprise-reporting` (default) and `node-rest`.** There is
no `tanstack-nestjs` target here — that one belongs to `app-with-ai-tanstack`, and
passing it is rejected with `Unsupported stack`. `tanstack` and `tanstack-start`
are accepted as *aliases for `enterprise-reporting`*, which is the likeliest way
to think you got a NestJS stack and not notice.

`enterprise-reporting` emits code to paste into this repository; `node-rest`
emits a standalone `node:http` app over a JSON file, with no install step.

### Generated output (enterprise-reporting stack)

```
generated/
├── src/
│   ├── server-fns/<entity>.ts         # createServerFn with .inputValidator()
│   ├── routes/_authed/<entity>/
│   │   ├── index.tsx                  # List page (TanStack Table + shadcn/ui)
│   │   └── $id.tsx                    # Detail/edit page
│   └── lib/db/migrations/<ts>_create_tables.ts   # PostgreSQL DDL via sql``
├── rules/<rule>.jdm.json              # one GoRules JDM graph per %%rule flow
├── KYSELY_TYPES.md                    # Database-interface snippet to paste in
└── README.md
```

It writes a `KYSELY_TYPES.md` snippet, **not** a `kysely-db.ts` — you paste the
snippet into the `Database` interface in `src/lib/db/kysely-db.ts` yourself.

**Both targets carry optimistic locking**, the contract the product's generated
applications use. Every generated table has a `version` column the application
raises on each save. The `enterprise-reporting` update server function takes
the version the form read and writes `UPDATE … WHERE version = <it>`, so a save
against a record someone else has saved since matches no row and is refused
with an error whose message starts `VERSION_CONFLICT`; the generated detail page
answers it with Reload their version / Overwrite with mine / Keep editing.
`node-rest` speaks the same contract over HTTP: `ETag` on a read, `If-Match` on
`PUT`, 409 with `details.code: "VERSION_CONFLICT"`. Its runtime under
`language/cli/runtime/` is byte-identical to the copies in
`app-with-ai-tanstack` and the orchestrator — change all three or none.

**The state field is never typed in `enterprise-reporting` output either.** For an
entity with a `kind: state` workflow, its state column (`status`, else `state`,
else `stage` — `language/state-field.ts`) is left out of the create/update zod
schema and the form, set to the machine's initial state on create, shown
read-only as a header badge (`data-testid="record-state"`) on the detail page and
always included as a column of the list. The update server function drops a
value sent back unchanged and refuses a different one with an error starting
`STATE_FIELD_SYSTEM_MANAGED`. In the product's stacks that column is the record's
lifecycle — Draft, its status flow, Final — and moves by **action buttons** along the
edges the diagram draws, each given to roles by `%%rbac … on E.<event>` (`EML511`
lists a move no line names, `EML512` the old rule-and-saga move pattern, `EML509` a
state named `final` or `error`; `EML215` and `EML507` are retired). This target
compiles neither workflows nor `%%rbac`, so it draws no buttons and nothing on its
screens moves a state.

### The CLI vendors two modules from app-with-ai-tanstack

`language/cli/src/vendor/` holds copies of that repository's
`packages/web/src/lib/jdm-converter.ts` and `packages/editors/src/lib/mermaid-flowchart-parser.ts` (the parser moved from `packages/web` when the editors became their own package), so a `%%rule`
flow compiles to the same JDM graph on both sides. They used to be imported
across the repository boundary as `../../../../packages/web/...`, which resolves
nowhere here — this repository has no `packages/` directory at all. Because
`cli.ts` imports the JDM emitter *statically*, that dangling path took down every
command, `validate` and `info` included, neither of which emits JDM. Both files
are dependency-free; re-copy them rather than editing them by hand.

## Repo-local Claude configuration

- `.claude/mcpServers.json` registers two MCP servers: `tanstack-start` (project structure/routes/server-fns/schema introspection, `bun .claude/mcp/tanstack-start-mcp.ts`) and `tanstack` (official TanStack docs search)
- `.claude/skills/bunjs-runtime.md` and `.claude/skills/tanstackstart-testing.md` hold Bun runtime and TanStack Start testing conventions

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
