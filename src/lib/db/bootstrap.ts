/**
 * Auto-bootstrap the database schema on first startup.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run on every boot.
 * The admin user is only inserted when no users exist.
 *
 * PostgreSQL only.
 */

import { sql } from "kysely";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Kysely } from "kysely";
import type { Database } from "./kysely-db";
import { seedHelpArticles } from "./help-seed";
import { BCRYPT_COST } from "@/lib/auth/bcrypt-cost";
import { getLogger } from "@/lib/logging/logger";

/*
 * The bootstrap accounts, and where their passwords come from.
 *
 * These used to be two pre-computed bcrypt hashes of the words "admin" and
 * "nlquery", compiled into the application. Every installation that had not
 * changed them — and nothing prompted anyone to — could be signed into by
 * anyone who had read this file, which is public. The nlquery row was worse
 * than the admin one: the admin is seeded only into an empty user table, while
 * nlquery was re-inserted on every boot, so deleting it did not stick.
 *
 * `ADMIN_PASSWORD` / `NLQUERY_PASSWORD` name the password instead. When either
 * is absent a random one is generated, printed once, and never stored anywhere
 * it can be read back — so a fresh installation is reachable by whoever ran it
 * and by nobody else, and an unattended one has no known password at all rather
 * than a published one.
 *
 * Rate limiting on the credential endpoints (src/lib/auth/better-auth.ts) is
 * the other half of this: a weak password that an operator sets deliberately
 * should at least not be guessable at network speed.
 */
function resolveBootstrapPassword(envVar: string, label: string): string {
  const configured = process.env[envVar];
  if (configured && configured.length >= 8) return configured;

  if (configured) {
    getLogger("db").event("db.bootstrap.password_ignored", {
      variable: envVar,
      reason: "shorter than 8 characters",
    });
  }

  const generated = randomBytes(18).toString("base64url");
  getLogger("db").event("db.bootstrap.password_generated", { label });
  // The one place a credential is printed, on purpose: the person who ran the platform has no
  // other way to learn it. It goes to stderr and not through the structured log, so it is never
  // an event a collector indexes or the System Logs table stores.
  process.stderr.write(
    `
[bootstrap] No ${envVar} set. Generated a random password for ${label}:

` +
      `    ${generated}

` +
      "This is printed once and is not recoverable. Sign in and change it, or set " +
      `${envVar} before first boot.

`
  );
  return generated;
}

const ADMIN_ID = "1aa00cc2af0225000c5c114df3eebb69";
const NLQUERY_USER_ID = "nlquery0user00000000000000000000";
const NLQUERY_ROLE_ID = "nlquery0role00000000000000000000";

/**
 * bcrypt, at the cost `src/lib/auth/better-auth.ts` verifies with. A seeder
 * hashing with anything else writes an account that cannot sign in, and the
 * failure reads as a wrong password.
 */
async function bcryptHash(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function bootstrapSchema(db: Kysely<Database>): Promise<void> {
  getLogger("db").event("db.bootstrap.trace", { what: "Starting database schema bootstrap..." });

  const tables = [
    sql`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      avatar_url VARCHAR(500),
      is_active BOOLEAN DEFAULT TRUE,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS roles (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      description TEXT,
      permissions TEXT NOT NULL,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS user_roles (
      user_id VARCHAR(255) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      assigned_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, role_id)
    )`,

    sql`CREATE TABLE IF NOT EXISTS data_sources (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      client_type VARCHAR(50) NOT NULL,
      connection_config TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      is_editable BOOLEAN DEFAULT FALSE,
      is_inspected BOOLEAN DEFAULT FALSE,
      last_inspected_at VARCHAR(255),
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS saved_queries (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      data_source_id VARCHAR(255) NOT NULL,
      sql_content TEXT NOT NULL,
      parameters_schema TEXT,
      is_validated BOOLEAN DEFAULT FALSE,
      validation_result TEXT,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    // A dataset is a saved query the browser loads into DuckDB-WASM. Nothing here is data:
    // the rows are produced at download time, for the person downloading, through
    // decideQueryRun. row_count / byte_size / columns are the stats of the last download.
    sql`CREATE TABLE IF NOT EXISTS datasets (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      saved_query_id VARCHAR(255) NOT NULL,
      row_count BIGINT NOT NULL DEFAULT 0,
      byte_size BIGINT NOT NULL DEFAULT 0,
      columns TEXT,
      last_built_at VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS report_definitions (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      saved_query_id VARCHAR(255),
      column_config TEXT NOT NULL,
      filter_config TEXT,
      sort_config TEXT,
      pagination_config TEXT,
      export_formats TEXT DEFAULT '["csv","xlsx","pdf"]',
      filename_template TEXT,
      color_theme TEXT,
      is_public BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS chart_definitions (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      saved_query_id VARCHAR(255),
      chart_type VARCHAR(50) NOT NULL,
      chart_config TEXT NOT NULL,
      data_mapping TEXT NOT NULL,
      refresh_interval INT,
      color_theme TEXT,
      is_public BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS dashboard_layouts (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      layout_config TEXT NOT NULL,
      theme_config TEXT,
      refresh_config TEXT,
      is_public BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id VARCHAR(255) PRIMARY KEY,
      dashboard_id VARCHAR(255) NOT NULL,
      widget_type VARCHAR(50) NOT NULL,
      report_id VARCHAR(255),
      chart_id VARCHAR(255),
      position_config TEXT NOT NULL,
      widget_config TEXT,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS job_definitions (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      job_type VARCHAR(50) NOT NULL,
      target_id VARCHAR(255) NOT NULL,
      schedule_cron VARCHAR(255),
      parameters TEXT,
      notification_config TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at VARCHAR(255),
      deleted_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS job_executions (
      id VARCHAR(255) PRIMARY KEY,
      job_definition_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL,
      started_at VARCHAR(255),
      completed_at VARCHAR(255),
      result_location VARCHAR(500),
      error_message TEXT,
      execution_metadata TEXT,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255),
      action VARCHAR(255) NOT NULL,
      resource_type VARCHAR(100) NOT NULL,
      resource_id VARCHAR(255),
      details TEXT,
      ip_address VARCHAR(45),
      user_agent VARCHAR(500),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS logs (
      id VARCHAR(255) PRIMARY KEY,
      timestamp VARCHAR(255) NOT NULL,
      level VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      component VARCHAR(255) NOT NULL,
      user_id VARCHAR(255),
      session_id VARCHAR(255),
      metadata TEXT,
      error_stack TEXT,
      request_id VARCHAR(255),
      message_vector TEXT
    )`,

    sql`CREATE TABLE IF NOT EXISTS email_templates (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      body TEXT NOT NULL,
      html_body TEXT,
      column_mappings TEXT,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS resource_permissions (
      id VARCHAR(255) PRIMARY KEY,
      resource_type VARCHAR(100) NOT NULL,
      resource_id VARCHAR(255) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      permission_level VARCHAR(50) NOT NULL,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS filter_definitions (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      data_source_id VARCHAR(255) NOT NULL,
      filter_query TEXT NOT NULL,
      display_field VARCHAR(255) NOT NULL,
      value_field VARCHAR(255) NOT NULL,
      field_type VARCHAR(50),
      operator VARCHAR(50),
      date_validation_config TEXT,
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS report_filters (
      id VARCHAR(255) PRIMARY KEY,
      report_id VARCHAR(255) NOT NULL,
      filter_id VARCHAR(255) NOT NULL,
      target_column VARCHAR(255) NOT NULL,
      filter_order INT NOT NULL,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS chart_filters (
      id VARCHAR(255) PRIMARY KEY,
      chart_id VARCHAR(255) NOT NULL,
      filter_id VARCHAR(255) NOT NULL,
      target_column VARCHAR(255) NOT NULL,
      filter_order INT NOT NULL,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS ds_roles (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS ds_user_roles (
      data_source_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      ds_role_id VARCHAR(255) NOT NULL,
      assigned_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (data_source_id, user_id, ds_role_id)
    )`,

    sql`CREATE TABLE IF NOT EXISTS ds_entity_permissions (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      ds_role_id VARCHAR(255) NOT NULL,
      entity_name VARCHAR(255) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_schema VARCHAR(255),
      permission_level VARCHAR(50) NOT NULL,
      column_restrictions TEXT,
      row_filter VARCHAR(500),
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS schema_field_instructions (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      field_name VARCHAR(255) NOT NULL,
      field_type VARCHAR(100) NOT NULL,
      is_nullable BOOLEAN DEFAULT FALSE,
      is_primary_key BOOLEAN DEFAULT FALSE,
      is_foreign_key BOOLEAN DEFAULT FALSE,
      foreign_key_table VARCHAR(255),
      foreign_key_field VARCHAR(255),
      description TEXT,
      llm_instructions TEXT,
      example_values TEXT,
      constraints TEXT,
      business_meaning TEXT,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(255),
      updated_by VARCHAR(255)
    )`,

    sql`CREATE TABLE IF NOT EXISTS schema_table_instructions (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      description TEXT,
      llm_instructions TEXT,
      example_queries TEXT,
      business_domain VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(255),
      updated_by VARCHAR(255)
    )`,

    sql`CREATE TABLE IF NOT EXISTS nl_query_context (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      role_name VARCHAR(255) NOT NULL,
      nl_question TEXT NOT NULL,
      generated_sql TEXT NOT NULL,
      nl_question_embedding TEXT,
      schema_context TEXT NOT NULL,
      rbac_context TEXT NOT NULL,
      field_instructions TEXT,
      execution_time_ms INT,
      row_count INT,
      was_successful BOOLEAN NOT NULL,
      error_message TEXT,
      translation_confidence DECIMAL(5,4),
      llm_confidence DECIMAL(5,4),
      query_type VARCHAR(100),
      table_count INT,
      join_count INT,
      has_aggregation BOOLEAN,
      has_window_function BOOLEAN,
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS nl_query_role_stats (
      id VARCHAR(255) PRIMARY KEY,
      role_name VARCHAR(255) NOT NULL,
      data_source_id VARCHAR(255) NOT NULL,
      total_queries INT,
      successful_queries INT,
      failed_queries INT,
      success_rate DECIMAL(5,4),
      avg_execution_time_ms DECIMAL(10,2),
      avg_rows_returned DECIMAL(10,2),
      avg_confidence DECIMAL(5,4),
      common_query_types TEXT,
      common_tables TEXT,
      common_joins TEXT,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS nl_query_feedback (
      id VARCHAR(255) PRIMARY KEY,
      nl_query_context_id VARCHAR(255) NOT NULL,
      feedback_type VARCHAR(100),
      user_feedback TEXT,
      corrected_sql TEXT,
      feedback_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS metadata_entity_header (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL,
      entity_name VARCHAR(255) NOT NULL,
      entity_schema VARCHAR(255),
      entity_type VARCHAR(50) NOT NULL DEFAULT 'table',
      schema_metadata TEXT NOT NULL,
      last_introspected_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      description TEXT,
      is_active BOOLEAN DEFAULT FALSE,
      is_hidden BOOLEAN DEFAULT TRUE,
      created_by VARCHAR(255),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (data_source_id, entity_name, entity_schema)
    )`,

    sql`CREATE TABLE IF NOT EXISTS metadata_entity_field (
      id VARCHAR(255) PRIMARY KEY,
      entity_header_id VARCHAR(255) NOT NULL,
      field_name VARCHAR(255) NOT NULL,
      data_type VARCHAR(255) NOT NULL,
      is_nullable BOOLEAN,
      is_primary_key BOOLEAN DEFAULT FALSE,
      is_foreign_key BOOLEAN DEFAULT FALSE,
      foreign_key_table VARCHAR(255),
      foreign_key_column VARCHAR(255),
      default_value TEXT,
      description TEXT,
      is_display_field BOOLEAN DEFAULT FALSE,
      is_searchable BOOLEAN DEFAULT TRUE,
      display_order INT,
      section_name VARCHAR(255),
      relationship_ui_type VARCHAR(50),
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (entity_header_id, field_name)
    )`,

    sql`CREATE TABLE IF NOT EXISTS ds_schema_cache (
      id VARCHAR(255) PRIMARY KEY,
      data_source_id VARCHAR(255) NOT NULL UNIQUE,
      schema_metadata TEXT NOT NULL,
      sample_data TEXT,
      embedding_data TEXT,
      last_introspected_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      created_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP,
      updated_at VARCHAR(255) DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS adk_intents (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      session_id VARCHAR(255),
      raw_nl_request TEXT NOT NULL,
      request_source VARCHAR(20) DEFAULT 'text',
      intent_type VARCHAR(50) NOT NULL,
      confidence DECIMAL(4,3),
      adk_intent_json TEXT NOT NULL,
      pipeline_status VARCHAR(20) DEFAULT 'pending',
      report_definition_id VARCHAR(255),
      monitoring_rule_id VARCHAR(255),
      error_message TEXT,
      classification_ms INT,
      total_pipeline_ms INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS monitoring_rules (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      report_definition_id VARCHAR(255) NOT NULL,
      job_definition_id VARCHAR(255),
      data_source_id VARCHAR(255) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      metric_column VARCHAR(255) NOT NULL,
      threshold_operator VARCHAR(20) NOT NULL,
      threshold_value DECIMAL(20,4) NOT NULL,
      threshold_upper_bound DECIMAL(20,4),
      escalation_threshold_pct DECIMAL(5,2) DEFAULT 20.0,
      cron_expression VARCHAR(100) NOT NULL,
      timezone VARCHAR(64) DEFAULT 'UTC',
      trigger_schedule_id VARCHAR(255),
      alert_channels TEXT NOT NULL,
      alert_recipients TEXT NOT NULL,
      webhook_url VARCHAR(500),
      notify_on_pass BOOLEAN DEFAULT FALSE,
      notify_on_no_data BOOLEAN DEFAULT TRUE,
      rbac_snapshot TEXT NOT NULL,
      rbac_snapshot_version INT DEFAULT 1,
      is_active BOOLEAN DEFAULT TRUE,
      is_paused BOOLEAN DEFAULT FALSE,
      pause_reason TEXT,
      original_nl_request TEXT,
      adk_intent_id VARCHAR(255),
      last_executed_at TIMESTAMP,
      last_execution_status VARCHAR(20),
      last_metric_value DECIMAL(20,4),
      consecutive_breaches INT DEFAULT 0,
      total_executions INT DEFAULT 0,
      total_alerts_sent INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS monitoring_executions (
      id VARCHAR(255) PRIMARY KEY,
      monitoring_rule_id VARCHAR(255) NOT NULL,
      job_execution_id VARCHAR(255),
      executed_at TIMESTAMP NOT NULL,
      execution_ms INT,
      rows_returned INT,
      sql_executed TEXT,
      metric_value DECIMAL(20,4),
      previous_metric_value DECIMAL(20,4),
      delta_pct DECIMAL(8,4),
      evaluation_status VARCHAR(20) NOT NULL,
      evaluation_detail TEXT,
      alert_dispatched BOOLEAN DEFAULT FALSE,
      alert_channels_used TEXT,
      alert_recipients_sent TEXT,
      alert_sent_at TIMESTAMP,
      error_message TEXT,
      error_phase VARCHAR(30),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS nl_report_definitions (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      data_source_id VARCHAR(255) NOT NULL,
      nl_query TEXT NOT NULL,
      generated_sql TEXT NOT NULL,
      metric_columns TEXT NOT NULL,
      dimension_columns TEXT NOT NULL,
      filter_config TEXT,
      date_range_from DATE,
      date_range_to DATE,
      chart_type VARCHAR(20) NOT NULL DEFAULT 'bar',
      output_formats TEXT NOT NULL,
      recipient_config TEXT NOT NULL,
      schedule_cron VARCHAR(100),
      schedule_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rbac_snapshot TEXT NOT NULL,
      rbac_snapshot_version INT DEFAULT 1,
      last_run_at TIMESTAMP,
      last_run_status VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS generated_report_artifacts (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      report_definition_id VARCHAR(255) NOT NULL,
      execution_id VARCHAR(255) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      format VARCHAR(10) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      file_size_bytes BIGINT,
      row_count INT,
      chart_type VARCHAR(20),
      execution_ms INT,
      status VARCHAR(20) NOT NULL DEFAULT 'complete',
      error_message TEXT,
      triggered_by VARCHAR(20) NOT NULL DEFAULT 'manual',
      sql_executed TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    sql`CREATE TABLE IF NOT EXISTS help_articles (
      id VARCHAR(255) PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      icon VARCHAR(100) NOT NULL DEFAULT 'HelpCircle',
      color VARCHAR(50) NOT NULL DEFAULT 'blue',
      title VARCHAR(255) NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      is_published BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // ── Better Auth ─────────────────────────────────────────────────────────
    //
    // Better Auth owns the session, credential and verification rows; the
    // `user` model is mapped onto the EXISTING `users` table above, so that
    // roles, user_roles, resource_permissions, ds_user_roles and the audit log
    // keep pointing at the same ids they always did. See src/lib/auth/better-auth.ts.
    //
    // These three use real TIMESTAMPTZ columns rather than the VARCHAR
    // timestamps the older tables use. Better Auth compares `expires_at`
    // against a Date to decide whether a session is still valid, and a VARCHAR
    // would hand it a string — a comparison that does not error, it just
    // silently stops expiring sessions.
    sql`CREATE TABLE IF NOT EXISTS auth_sessions (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address VARCHAR(255),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    sql`CREATE TABLE IF NOT EXISTS auth_accounts (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id VARCHAR(255) NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at TIMESTAMPTZ,
      refresh_token_expires_at TIMESTAMPTZ,
      scope TEXT,
      password TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    sql`CREATE TABLE IF NOT EXISTS auth_verifications (
      id VARCHAR(255) PRIMARY KEY,
      identifier VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];

  // Additive columns for tables that predate the feature needing them. Separate
  // from `tables` because CREATE TABLE IF NOT EXISTS does nothing to a table
  // that already exists — an installation upgraded in place would otherwise
  // never get these.
  const alters = [
    // Better Auth requires emailVerified on the user model.
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    // What kind of failure a log line is, and which catalogue code: the System Logs filters.
    sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS category VARCHAR(50)`,
    sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS code VARCHAR(100)`,
    sql`CREATE INDEX IF NOT EXISTS idx_logs_request_id ON logs (request_id)`,
    // The credential now lives in auth_accounts.password. The column stays for
    // the migration below to read, but a Better-Auth-created user never fills
    // it, so it can no longer be NOT NULL.
    sql`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`,
    // Record links — see src/lib/reporting/record-link.ts. JSON, nullable: a
    // report without one is the normal case.
    sql`ALTER TABLE report_definitions ADD COLUMN IF NOT EXISTS record_link_config TEXT`,
  ];

  // Indexes — separate statements because PostgreSQL doesn't support inline index creation
  const indexes = [
    sql`CREATE INDEX IF NOT EXISTS idx_adk_user_id ON adk_intents (user_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_adk_created_at ON adk_intents (created_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_mr_created_by ON monitoring_rules (created_by)`,
    sql`CREATE INDEX IF NOT EXISTS idx_mr_data_source_id ON monitoring_rules (data_source_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_mr_is_active ON monitoring_rules (is_active)`,
    sql`CREATE INDEX IF NOT EXISTS idx_me_rule_id ON monitoring_executions (monitoring_rule_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_me_executed_at ON monitoring_executions (executed_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_me_status ON monitoring_executions (evaluation_status)`,
    sql`CREATE INDEX IF NOT EXISTS idx_notif_user_read ON notifications (user_id, is_read, created_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_nlrd_created_by ON nl_report_definitions (created_by)`,
    sql`CREATE INDEX IF NOT EXISTS idx_nlrd_data_source ON nl_report_definitions (data_source_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_nlrd_created_at ON nl_report_definitions (created_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_gra_definition ON generated_report_artifacts (report_definition_id, created_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_gra_user ON generated_report_artifacts (created_by, created_at)`,
    sql`CREATE INDEX IF NOT EXISTS idx_gra_execution ON generated_report_artifacts (execution_id)`,
    // Better Auth looks a session up by token on every authenticated request.
    sql`CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions (token)`,
    sql`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_auth_accounts_user ON auth_accounts (user_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_auth_verifications_identifier ON auth_verifications (identifier)`,
  ];

  getLogger("db").event("db.bootstrap.trace", { what: "Creating tables..." });
  for (const table of tables) {
    try {
      await table.execute(db);
    } catch (err) {
      getLogger("db").event("db.bootstrap.degraded", { what: "Table create warning", detail: [(err as Error).message?.slice(0, 120)] });
    }
  }

  for (const alter of alters) {
    try {
      await alter.execute(db);
    } catch (err) {
      getLogger("db").event("db.bootstrap.degraded", { what: "Alter warning", detail: [(err as Error).message?.slice(0, 120)] });
    }
  }

  getLogger("db").event("db.bootstrap.trace", { what: "Creating indexes..." });
  for (const idx of indexes) {
    try {
      await idx.execute(db);
    } catch (err) {
      getLogger("db").event("db.bootstrap.degraded", { what: "Index create warning", detail: [(err as Error).message?.slice(0, 120)] });
    }
  }

  /*
   * One permission row per (data source, role, entity, schema). `entity_schema` is
   * nullable and in the common case NULL, and a plain unique index treats NULLs as
   * distinct — so it would allow the duplicates it exists to prevent. NULLS NOT DISTINCT
   * is Postgres 15+; on an older server this warns and `upsertDsEntityPermission` still
   * works, because it no longer relies on the index. Any duplicates already present are
   * removed first, or the index could not be built.
   */
  try {
    await sql`DELETE FROM ds_entity_permissions a USING ds_entity_permissions b
      WHERE a.ctid < b.ctid
        AND a.data_source_id = b.data_source_id
        AND a.ds_role_id = b.ds_role_id
        AND a.entity_name = b.entity_name
        AND a.entity_schema IS NOT DISTINCT FROM b.entity_schema`.execute(db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ds_entity_permissions_entity_key
      ON ds_entity_permissions (data_source_id, ds_role_id, entity_name, entity_schema)
      NULLS NOT DISTINCT`.execute(db);
  } catch (err) {
    getLogger("db").event("db.bootstrap.degraded", { what: "Ds_entity_permissions unique index warning", detail: [(err as Error).message?.slice(0, 160)] });
  }

  /*
   * email_templates: the query a template is written against, and who wrote it. The editor
   * has always sent `queryId`, and the original migration had a `query_id` column, but the
   * table bootstrap creates did not — so the choice could not be stored. Additive and
   * idempotent; an existing installation keeps its rows.
   */
  for (const stmt of [
    sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS query_id VARCHAR(255)`,
    sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`,
    // The minute a scheduled run was for. The unique index makes "claim this minute" a single
    // INSERT, so two processes (the web server and `jobs:worker`) or a restart mid-minute cannot
    // run the same job twice. Manual runs leave it NULL, and NULLs are distinct.
    sql`ALTER TABLE job_executions ADD COLUMN IF NOT EXISTS scheduled_for VARCHAR(255)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_executions_claim
        ON job_executions(job_definition_id, scheduled_for)`,
  ]) {
    try {
      await stmt.execute(db);
    } catch (err) {
      getLogger("db").event("db.bootstrap.degraded", { what: "Email_templates column warning", detail: [(err as Error).message?.slice(0, 120)] });
    }
  }

  // Seed admin user and role
  getLogger("db").event("db.bootstrap.trace", { what: "Seeding admin user..." });
  const adminRoleId = "admin-role-id";
  const ADMIN_PERMISSIONS = JSON.stringify([
    "*:*",
    "admin:*",
    "user:*",
    "role:*",
    "data_source:*",
    "report:*",
    "dashboard:*",
    "chart:*",
    "query:*",
    "job:*",
    "audit:*",
    "nl_query:*",
    "filter:*",
    "monitoring_rule:*",
    "log:*",
    "setting:*",
    "queue:*",
    "metadata_entity:*",
  ]);

  const now = new Date().toISOString();

  // Upsert admin role (PostgreSQL ON CONFLICT syntax)
  await db
    .insertInto("roles")
    .values({
      id: adminRoleId,
      name: "Administrator",
      description: "Full system administrator",
      permissions: ADMIN_PERMISSIONS,
      created_at: now,
    })
    .onConflict((oc) => oc.column("id").doUpdateSet({ permissions: ADMIN_PERMISSIONS }))
    .execute()
    .catch((err) => {
      getLogger("db").event("db.bootstrap.degraded", { what: "Admin role upsert warning", detail: [(err as Error).message?.slice(0, 120)] });
    });

  const userCount = await db
    .selectFrom("users")
    .select(db.fn.count<number>("id").as("count"))
    .executeTakeFirst();

  if (!userCount || Number(userCount.count) === 0) {
    await db
      .insertInto("users")
      .values({
        id: ADMIN_ID,
        email: "admin@admin.com",
        password_hash: await bcryptHash(
          resolveBootstrapPassword("ADMIN_PASSWORD", "admin@admin.com")
        ),
        display_name: "System Administrator",
        avatar_url: null,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
      .execute()
      .catch((err) => {
        getLogger("db").event("db.bootstrap.degraded", { what: "Admin user insert warning", detail: [(err as Error).message?.slice(0, 120)] });
      });

    await db
      .insertInto("user_roles")
      .values({ user_id: ADMIN_ID, role_id: adminRoleId, assigned_at: now })
      .execute()
      .catch((err) => {
        getLogger("db").event("db.bootstrap.degraded", { what: "Admin user_roles insert warning", detail: [(err as Error).message?.slice(0, 120)] });
      });

    getLogger("db").event("db.bootstrap.trace", { what: "Admin created: admin@admin.com" });
  }

  const nlQueryPermissions = JSON.stringify(["nl_query:*"]);
  const now2 = new Date().toISOString();

  await db
    .insertInto("roles")
    .values({
      id: NLQUERY_ROLE_ID,
      name: "NLQueryUser",
      description: "Access limited to natural language query only",
      permissions: nlQueryPermissions,
      created_at: now2,
    })
    .onConflict((oc) => oc.column("id").doUpdateSet({ permissions: nlQueryPermissions }))
    .execute()
    .catch((err) => {
      getLogger("db").event("db.bootstrap.degraded", { what: "Nlquery role insert warning", detail: [(err as Error).message?.slice(0, 120)] });
    });

  /*
   * Only insert when the row is genuinely absent.
   *
   * This was an unconditional insert with `onConflict … doNothing`, which reads
   * as harmless and is not: resolving the password is now a side-effecting
   * operation — it may generate one and print it — and doing that on every boot
   * would print a new password each time for an account that already exists and
   * is not being changed. Asking first keeps the generated password to the one
   * boot that actually creates the account.
   */
  const existingNlQuery = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", NLQUERY_USER_ID)
    .executeTakeFirst();

  if (!existingNlQuery) {
    await db
      .insertInto("users")
      .values({
        id: NLQUERY_USER_ID,
        email: "nlquery@nlquery.com",
        password_hash: await bcryptHash(
          resolveBootstrapPassword("NLQUERY_PASSWORD", "nlquery@nlquery.com")
        ),
        display_name: "nlquery",
        avatar_url: null,
        is_active: true,
        created_at: now2,
        updated_at: now2,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute()
      .catch((err) => {
        getLogger("db").event("db.bootstrap.degraded", { what: "Nlquery user insert warning", detail: [(err as Error).message?.slice(0, 120)] });
      });
  }

  await db
    .insertInto("user_roles")
    .values({ user_id: NLQUERY_USER_ID, role_id: NLQUERY_ROLE_ID, assigned_at: now2 })
    .onConflict((oc) => oc.columns(["user_id", "role_id"]).doNothing())
    .execute()
    .catch((err) => {
      getLogger("db").event("db.bootstrap.degraded", { what: "Nlquery user_roles insert warning", detail: [(err as Error).message?.slice(0, 120)] });
    });

  getLogger("db").event("db.bootstrap.trace", { what: "NL Query user ensured: nlquery@nlquery.com" });

  // ── Credentials into Better Auth ──────────────────────────────────────────
  //
  // Better Auth reads the password from `auth_accounts.password` for the
  // `credential` provider, not from `users.password_hash`. Every user that
  // predates the migration — and the two seeded above — therefore needs an
  // account row, or the password sitting in `users` verifies against nothing
  // and a correct password is rejected as wrong.
  //
  // Copying the hash across rather than re-hashing is what makes this a
  // migration and not a password reset: `hash`/`verify` in
  // src/lib/auth/better-auth.ts are bcryptjs precisely so these hashes stay
  // valid. Idempotent — a user who already has a credential row is skipped.
  const usersNeedingCredential = await db
    .selectFrom("users")
    .leftJoin("auth_accounts", (join) =>
      join
        .onRef("auth_accounts.user_id", "=", "users.id")
        .on("auth_accounts.provider_id", "=", "credential")
    )
    .where("auth_accounts.id", "is", null)
    .where("users.password_hash", "is not", null)
    .select(["users.id as id", "users.password_hash as password_hash"])
    .execute()
    .catch(() => [] as { id: string; password_hash: string | null }[]);

  for (const user of usersNeedingCredential) {
    if (!user.password_hash) continue;
    await db
      .insertInto("auth_accounts")
      .values({
        id: `cred_${user.id}`.slice(0, 255),
        user_id: user.id,
        account_id: user.id,
        provider_id: "credential",
        password: user.password_hash,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute()
      .catch((err) => {
        getLogger("db").event("db.bootstrap.degraded", { what: "Credential migration warning", detail: [(err as Error).message?.slice(0, 120)] });
      });
  }

  if (usersNeedingCredential.length > 0) {
    getLogger("db").event("db.bootstrap.trace", { what: `Migrated ${usersNeedingCredential.length} credential(s) into Better Auth` });
  }

  getLogger("db").event("db.bootstrap.trace", { what: "Seeding help articles..." });
  await seedHelpArticles(db);

  getLogger("db").event("db.bootstrap.trace", { what: "Database bootstrap complete!" });
}
