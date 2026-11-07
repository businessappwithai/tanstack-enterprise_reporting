/**
 * Kysely Database Configuration
 * Config database: PostgreSQL only (via DATABASE_URL or POSTGRES_* env vars)
 */

import { type Generated, Kysely, PostgresDialect, sql } from "kysely";
import type { DatabaseClientType } from "@/types/database";
import { Pool as PostgresPool } from "pg";
import { bootstrapSchema } from "./bootstrap";
import { setSinkWriter } from "@/lib/logging/db-sink";
import { getLogger } from "@/lib/logging/logger";

export interface Database {
  users: UsersTable;
  roles: RolesTable;
  user_roles: UserRolesTable;
  data_sources: DataSourcesTable;
  saved_queries: SavedQueriesTable;
  report_definitions: ReportDefinitionsTable;
  chart_definitions: ChartDefinitionsTable;
  dashboard_layouts: DashboardLayoutsTable;
  dashboard_widgets: DashboardWidgetsTable;
  job_definitions: JobDefinitionsTable;
  job_executions: JobExecutionsTable;
  audit_log: AuditLogTable;
  logs: LogsTable;
  email_templates: EmailTemplatesTable;
  resource_permissions: ResourcePermissionsTable;
  datasets: DatasetsTable;
  filter_definitions: FilterDefinitionsTable;
  report_filters: ReportFiltersTable;
  chart_filters: ChartFiltersTable;
  ds_roles: DsRolesTable;
  ds_user_roles: DsUserRolesTable;
  ds_entity_permissions: DsEntityPermissionsTable;
  schema_field_instructions: SchemaFieldInstructionsTable;
  metadata_entity_header: MetadataEntityHeaderTable;
  metadata_entity_field: MetadataEntityFieldTable;
  error_messages: ErrorMessagesTable;
  warning_configs: WarningConfigsTable;
  error_occurrences: ErrorOccurrencesTable;
  app_settings: AppSettingsTable;
  schema_table_instructions: SchemaTableInstructionsTable;
  nl_query_context: NLQueryContextTable;
  nl_query_role_stats: NLQueryRoleStatsTable;
  nl_query_feedback: NLQueryFeedbackTable;
  help_articles: HelpArticleRow;
  // Better Auth — see src/lib/auth/better-auth.ts. The `user` model is mapped
  // onto the existing `users` table above rather than getting one of its own.
  auth_sessions: AuthSessionsTable;
  auth_accounts: AuthAccountsTable;
  auth_verifications: AuthVerificationsTable;
}

export interface UsersTable {
  id: string;
  email: string;
  /**
   * Legacy bcrypt credential. Better Auth keeps the live password in
   * `auth_accounts.password`; this column is only read by the one-time
   * migration in bootstrap that copies it across, and is null for any user
   * created since.
   */
  password_hash: string | null;
  display_name: string;
  avatar_url: string | null;
  /**
   * `Generated` because the column carries a DB default. Better Auth writes it;
   * everything else that inserts a user (seeds, the admin scripts, the users
   * admin screen) predates the column and must not have to know about it.
   */
  email_verified: Generated<boolean>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthSessionsTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuthAccountsTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  scope: string | null;
  password: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuthVerificationsTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface RolesTable {
  id: string;
  name: string;
  description: string | null;
  permissions: string; // JSON array
  created_at: string;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
  assigned_at: string;
}

export interface DataSourcesTable {
  id: string;
  name: string;
  description: string | null;
  client_type: DatabaseClientType;
  connection_config: string; // Encrypted JSON
  is_active: boolean;
  is_editable: boolean | null;
  is_inspected: boolean | null;
  last_inspected_at: string | null;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedQueriesTable {
  id: string;
  name: string;
  description: string | null;
  data_source_id: string;
  sql_content: string;
  parameters_schema: string | null; // JSON Schema
  is_validated: boolean;
  validation_result: string | null; // JSON
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportDefinitionsTable {
  id: string;
  name: string;
  description: string | null;
  saved_query_id: string | null;
  column_config: string; // JSON
  filter_config: string | null; // JSON
  sort_config: string | null; // JSON
  pagination_config: string | null; // JSON
  export_formats: string; // JSON array
  filename_template: string | null;
  color_theme: string | null; // JSON
  /**
   * JSON `RecordLinkConfig` — the button that opens a row's record in another
   * application. Administrator-only to set; see src/lib/reporting/record-link.ts.
   */
  record_link_config: string | null;
  is_public: boolean | null;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChartDefinitionsTable {
  id: string;
  name: string;
  description: string | null;
  saved_query_id: string | null;
  chart_type: string;
  chart_config: string; // JSON
  data_mapping: string; // JSON
  refresh_interval: number | null;
  color_theme: string | null; // JSON
  is_public: boolean | null;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardLayoutsTable {
  id: string;
  name: string;
  description: string | null;
  layout_config: string; // JSON
  theme_config: string | null; // JSON
  refresh_config: string | null; // JSON
  is_public: boolean;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardWidgetsTable {
  id: string;
  dashboard_id: string;
  widget_type: string;
  report_id: string | null;
  chart_id: string | null;
  position_config: string; // JSON
  widget_config: string | null; // JSON
  created_at: string;
  updated_at: string;
}

export interface JobDefinitionsTable {
  id: string;
  name: string;
  job_type: string;
  target_id: string;
  schedule_cron: string | null;
  parameters: string | null; // JSON
  notification_config: string | null; // JSON
  is_active: boolean;
  is_deleted: boolean | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobsTable {
  id: string;
  name: string;
  description: string | null;
  query_id: string | null;
  report_id: string | null;
  schedule: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobExecutionsTable {
  id: string;
  job_definition_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  result_location: string | null;
  error_message: string | null;
  execution_metadata: string | null; // JSON
  /** UTC minute (ISO) a scheduled run was claimed for; null for a manual run. */
  scheduled_for: string | null;
  created_at: string;
}

export interface AuditLogTable {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null; // JSON
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface LogsTable {
  id?: string;
  timestamp: string;
  level: string;
  message: string;
  component: string;
  user_id: string | null;
  session_id: string | null;
  metadata: string | null; // JSON
  error_stack: string | null;
  request_id: string | null;
  message_vector: string | null;
  /** Error category (`validation`, `integration`, …) when the line is about a failure. */
  category?: string | null;
  /** Catalogue code (`QUERY_FAILED`, …) when the line is about a failure. */
  code?: string | null;
}

export interface EmailTemplatesTable {
  id: string;
  name: string;
  subject: string;
  body: string;
  html_body: string | null;
  column_mappings: string | null;
  query_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatasetsTable {
  id: string;
  name: string;
  description: string | null;
  saved_query_id: string;
  row_count: number | string; // BIGINT: pg returns it as a string
  byte_size: number | string;
  columns: string | null; // JSON: [{ name, type, nullable }] from the last download
  last_built_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourcePermissionsTable {
  id: string;
  resource_type: string;
  resource_id: string;
  role_id: string;
  permission_level: string;
  created_at: string;
}

export interface FilterDefinitionsTable {
  id: string;
  name: string;
  description: string | null;
  data_source_id: string;
  filter_query: string;
  display_field: string;
  value_field: string;
  field_type: string | null;
  operator: string | null;
  date_validation_config: string | null; // JSON
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportFiltersTable {
  id: string;
  report_id: string;
  filter_id: string;
  target_column: string;
  filter_order: number;
  created_at: string;
}

export interface ChartFiltersTable {
  id: string;
  chart_id: string;
  filter_id: string;
  target_column: string;
  filter_order: number;
  created_at: string;
}

export interface DsRolesTable {
  id: string;
  data_source_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DsUserRolesTable {
  data_source_id: string;
  user_id: string;
  ds_role_id: string;
  assigned_at: string;
}

export interface DsEntityPermissionsTable {
  id: string;
  data_source_id: string;
  ds_role_id: string;
  entity_name: string;
  entity_type: string;
  entity_schema: string | null;
  permission_level: string;
  column_restrictions: string | null; // JSON
  row_filter: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors error_messages in scripts/init-postgres.ts. */
export interface ErrorMessagesTable {
  id: string;
  error_code: string;
  severity: "error" | "warning" | "info" | null;
  title: string;
  message: string;
  user_message: string | null;
  suggestions: string | null;
  documentation_url: string | null;
  is_active: boolean | null;
  category: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors warning_configs in scripts/init-postgres.ts. */
export interface WarningConfigsTable {
  id: string;
  warning_code: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: string | null;
  severity: "info" | "warning" | "critical" | null;
  message_template: string;
  suggestions_template: string | null;
  is_active: boolean | null;
  display_duration: number | null;
  require_dismissal: boolean | null;
  enable_auto_resolve: boolean | null;
  auto_resolve_after: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors error_occurrences in scripts/init-postgres.ts. */
export interface ErrorOccurrencesTable {
  id: string;
  error_message_id: string | null;
  user_id: string | null;
  session_id: string | null;
  error_code: string | null;
  error_message: string | null;
  stack_trace: string | null;
  component_stack: string | null;
  url: string | null;
  user_agent: string | null;
  context_data: string | null;
  is_reported: boolean | null;
  is_resolved: boolean | null;
  resolved_at: string | null;
  created_at: string;
}

/** Mirrors app_settings in scripts/init-postgres.ts. */
export interface AppSettingsTable {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/** Mirrors metadata_entity_header in bootstrapSchema()/rebuild-db.ts. */
export interface MetadataEntityHeaderTable {
  id: string;
  data_source_id: string;
  entity_name: string;
  entity_schema: string | null;
  entity_type: string;
  schema_metadata: string;
  last_introspected_at: string | null;
  description: string | null;
  is_active: boolean | null;
  is_hidden: boolean | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors metadata_entity_field in bootstrapSchema()/rebuild-db.ts. */
export interface MetadataEntityFieldTable {
  id: string;
  entity_header_id: string;
  field_name: string;
  data_type: string;
  is_nullable: boolean | null;
  is_primary_key: boolean | null;
  is_foreign_key: boolean | null;
  foreign_key_table: string | null;
  foreign_key_column: string | null;
  default_value: string | null;
  description: string | null;
  is_display_field: boolean | null;
  is_searchable: boolean | null;
  display_order: number | null;
  section_name: string | null;
  relationship_ui_type: "dropdown" | "popup" | "tab" | null;
  created_at: string;
  updated_at: string;
}

export interface SchemaFieldInstructionsTable {
  id: string;
  data_source_id: string;
  table_name: string;
  field_name: string;
  field_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  foreign_key_table: string | null;
  foreign_key_field: string | null;
  description: string | null;
  llm_instructions: string | null;
  example_values: string | null;
  constraints: string | null;
  business_meaning: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface SchemaTableInstructionsTable {
  id: string;
  data_source_id: string;
  table_name: string;
  description: string | null;
  llm_instructions: string | null;
  example_queries: string | null;
  business_domain: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface NLQueryContextTable {
  id: string;
  data_source_id: string;
  user_id: string;
  role_name: string;
  nl_question: string;
  generated_sql: string;
  nl_question_embedding: string | null;
  schema_context: string; // JSON
  rbac_context: string; // JSON
  field_instructions: string | null; // JSON
  execution_time_ms: number | null;
  row_count: number | null;
  was_successful: boolean;
  error_message: string | null;
  translation_confidence: number | null;
  llm_confidence: number | null;
  query_type: string | null;
  table_count: number | null;
  join_count: number | null;
  has_aggregation: boolean | null;
  has_window_function: boolean | null;
  created_by: string | null;
  created_at: string;
}

export interface NLQueryRoleStatsTable {
  id: string;
  role_name: string;
  data_source_id: string;
  total_queries: number | null;
  successful_queries: number | null;
  failed_queries: number | null;
  success_rate: number | null;
  avg_execution_time_ms: number | null;
  avg_rows_returned: number | null;
  avg_confidence: number | null;
  common_query_types: string | null; // JSON
  common_tables: string | null; // JSON
  common_joins: string | null; // JSON
  updated_at: string;
}

export interface NLQueryFeedbackTable {
  id: string;
  nl_query_context_id: string;
  feedback_type: string | null;
  user_feedback: string | null;
  corrected_sql: string | null;
  feedback_by: string | null;
  created_at: string;
}

export interface HelpArticleRow {
  id: string;
  category: string;
  icon: string;
  color: string;
  title: string;
  summary: string;
  content: string;
  keywords: string;
  sort_order: number;
  is_published: number;
  created_at: string;
  updated_at: string;
}

export type KyselyDB = Kysely<Database>;

let db: KyselyDB | null = null;

function buildConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.POSTGRES_HOST || process.env.PGHOST || "localhost";
  const port = process.env.POSTGRES_PORT || process.env.PGPORT || "5432";
  const database = process.env.POSTGRES_DB || process.env.PGDATABASE || "enterprise_config";
  const user = process.env.POSTGRES_USER || process.env.PGUSER || "enterprise";
  const password = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "";

  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function initializeDatabase(): KyselyDB {
  const connectionString = buildConnectionString();
  const safeUrl = connectionString.replace(/:([^@]+)@/, ":***@");
  getLogger("db").event("db.core.trace", { what: `Connecting to PostgreSQL: ${safeUrl}` });

  const pool = new PostgresPool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle client that the server drops (a restart, a failover, an idle timeout on a
  // pooler) is reported as an `error` event on the pool. With no listener, Node treats
  // that as unhandled and the whole process exits: stopping PostgreSQL for a moment took
  // the application down with it. The pool discards the broken client itself, and the
  // next query gets a fresh one, so logging is all there is to do here.
  pool.on("error", (err: Error) => {
    getLogger("db").event("db.pool.error", { pool: "config", err });
  });

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

let bootstrapPromise: Promise<void> | null = null;

/** Arbitrary, stable: the key every process serialises its schema bootstrap on. */
const BOOTSTRAP_LOCK_KEY = 7316504221;

/**
 * Run the schema bootstrap with the whole database holding one lock.
 *
 * `bootstrapSchema` is idempotent, but not concurrently: the web server and the reporting-pack
 * seeder (a second process, started beside it by compose) both call `getDb()` at start, each
 * created tables the other was also creating, and one of them failed part-way — leaving a schema
 * with no `job_definitions` and no administrator ("relation does not exist", then "no users"). A
 * session advisory lock makes the second process wait for the first and then find nothing to do.
 */
async function bootstrapOnce(database: KyselyDB): Promise<void> {
  await database.connection().execute(async (lock) => {
    await sql`select pg_advisory_lock(${BOOTSTRAP_LOCK_KEY})`.execute(lock);
    try {
      await bootstrapSchema(database);
    } finally {
      await sql`select pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`.execute(lock);
    }
  });
}

export function getDb(): KyselyDB {
  if (!db) {
    db = initializeDatabase();

    bootstrapPromise = bootstrapOnce(db)
      .then(() => getLogger("db").event("db.core.trace", { what: "Database ready" }))
      .catch((err) => getLogger("db").event("db.core.failed", { what: "Bootstrap failed", err: err }));

    // internal bootstrap tracking
    (db as any).__bootstrapPromise = bootstrapPromise;
  }
  return db;
}

export async function waitForDatabaseReady(): Promise<void> {
  getDb();
  if (bootstrapPromise) await bootstrapPromise;
}

export function getConfigDB(): KyselyDB {
  return getDb();
}

export async function closeDb(): Promise<void> {
  if (db) {
    try {
      await db.destroy();
    } catch (err) {
      getLogger("db").event("db.core.failed", { what: "Error closing database", err: err });
    }
    db = null;
  }
}

/** Always true — config DB is now exclusively PostgreSQL */
export function isPostgres(): boolean {
  return true;
}

/**
 * The System Logs table is written through this connection. Registered here, in the module that
 * owns the connection, so the logger never imports the database (it is also bundled for pages
 * that render in a browser).
 */
setSinkWriter(async (rows) => {
  await getDb()
    .insertInto("logs")
    .values(rows as never)
    .execute();
});
