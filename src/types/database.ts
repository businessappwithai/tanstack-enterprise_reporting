// User Types
export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  avatar_url?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** What listUsers/getUser return: a user with the roles joined on. */
export interface UserWithRoles extends Omit<User, "password_hash"> {
  roles?: Array<{ id: string; name: string }>;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string;
  created_at: string;
}

export interface UserRole {
  user_id: string;
  role_id: string;
  assigned_at: string;
}

// Data Source Types
export type DatabaseClientType = "pg" | "mysql" | "mssql" | "sqlite3" | "oracledb";

export interface DataSource {
  id: string;
  name: string;
  description?: string | null;
  client_type: DatabaseClientType;
  connection_config: string;
  is_active: boolean;
  is_deleted?: boolean | null;
  is_editable?: boolean | null;
  is_inspected?: boolean | null;
  last_inspected_at?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DataSourceConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filename?: string;
  ssl?: boolean;
  pool?: {
    min: number;
    max: number;
  };
}

// Query Types
export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  data_source_id: string;
  sql_content: string;
  parameters_schema?: string;
  is_validated: boolean;
  validation_result?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface QueryParameter {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "datetime";
  label?: string;
  defaultValue?: SerializableValue;
  required?: boolean;
  options?: Array<{ label: string; value: unknown }>;
}

// Report Color Theme
export interface ReportColorTheme {
  headerBackgroundColor?: string;
  headerTextColor?: string;
  headerFontWeight?: "normal" | "bold" | "600" | "700";
  rowBackgroundColor?: string;
  rowTextColor?: string;
  alternatingRowBackgroundColor?: string;
  alternatingRowTextColor?: string;
  borderColor?: string;
}

// Report Types
export interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  saved_query_id?: string;
  column_config: string;
  filter_config?: string;
  sort_config?: string;
  pagination_config?: string;
  export_formats: string;
  filename_template?: string;
  color_theme?: string;
  /**
   * JSON `RecordLinkConfig`, when an administrator has configured a link from
   * this report's rows to the same record in another application. Read it with
   * `parseRecordLinkConfig` — see src/lib/reporting/record-link.ts.
   */
  record_link_config?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
  is_public?: boolean;
}

export interface ColumnDefinition {
  id: string;
  field: string;
  header: string;
  visible: boolean;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  sortable: boolean;
  filterable: boolean;
  resizable: boolean;
  formatter?: FormatterDefinition;
  conditionalFormatting?: ConditionalFormat[];
  aggregation?: AggregationType;
  cellRenderer?: CellRendererType;
  cellRendererConfig?: Record<string, unknown>;
}

export type FormatterType =
  | "text"
  | "number"
  | "currency"
  | "percentage"
  | "date"
  | "datetime"
  | "boolean"
  | "custom";

export interface FormatterDefinition {
  type: FormatterType;
  options?: {
    locale?: string;
    currency?: string;
    decimals?: number;
    dateFormat?: string;
    prefix?: string;
    suffix?: string;
    trueLabel?: string;
    falseLabel?: string;
    customFormatter?: string;
  };
}

export interface ConditionalFormat {
  id: string;
  condition: {
    operator: ConditionalOperator;
    value: unknown;
    value2?: unknown;
  };
  style: {
    backgroundColor?: string;
    textColor?: string;
    fontWeight?: "normal" | "bold";
    icon?: string;
    iconColor?: string;
  };
}

export type ConditionalOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "between"
  | "in";

export type AggregationType = "sum" | "avg" | "count" | "min" | "max";

export type CellRendererType = "default" | "link" | "badge" | "progress" | "custom";

// Chart Types
export type ChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "column"
  | "doughnut"
  | "composed";

export interface ChartDefinition {
  id: string;
  name: string;
  description?: string;
  saved_query_id?: string;
  chart_type: ChartType;
  chart_config: string;
  data_mapping: string;
  refresh_interval?: number;
  is_public?: boolean | null;
  is_deleted?: boolean | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ChartConfig {
  title?: {
    show?: boolean;
    text: string;
    fontSize?: number;
    fontWeight?: string;
  };
  legend?: {
    show: boolean;
    position: "top" | "bottom";
  };
  xAxis?: AxisConfig;
  yAxis?: AxisConfig;
  colors?: string[];
  tooltip?: {
    enabled: boolean;
    formatter?: string;
  };
  animation?: boolean;
  stacked?: boolean;
}

export interface AxisConfig {
  label?: string;
  tickFormatter?: string;
  domain?: [number | "auto", number | "auto"];
  hide?: boolean;
}

export interface DataMapping {
  xAxis: AxisMapping;
  yAxis: SeriesMapping[];
  groupBy?: string;
  colorBy?: string;
}

export interface AxisMapping {
  field: string;
  label?: string;
}

export interface SeriesMapping {
  field: string;
  label?: string;
  color?: string;
}

export interface FieldMapping {
  field: string;
  label?: string;
  formatter?: FormatterDefinition;
  aggregation?: AggregationType;
}

// Filter Types
export type FilterFieldType = "id" | "number" | "date" | "text";

export type FilterOperator =
  | "in" // For ID fields: IN clause with multiselect
  | "equals" // For numbers: ==
  | "less_than" // For numbers: <
  | "less_than_equal" // For numbers: <=
  | "greater_than" // For numbers: >
  | "greater_than_equal" // For numbers: >=
  | "between" // For dates: BETWEEN
  | "starts_with" // For text: STARTS WITH
  | "contains"; // For text: CONTAINS

export interface DateValidationConfig {
  max_from_date?: string; // From date must be <= this date (ISO format)
  min_to_date?: string; // To date must be >= this date (ISO format)
}

export interface FilterDefinition {
  id: string;
  name: string;
  description?: string;
  data_source_id: string;
  filter_query: string;
  display_field: string;
  value_field: string;
  field_type?: FilterFieldType;
  operator?: FilterOperator;
  date_validation_config?: string; // JSON string of DateValidationConfig
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ReportFilter {
  id: string;
  report_id: string;
  filter_id: string;
  target_column: string;
  filter_order: number;
  created_at: string;
}

export interface ChartFilter {
  id: string;
  chart_id: string;
  filter_id: string;
  target_column: string;
  filter_order: number;
  created_at: string;
}

export interface FilterOption {
  value: string | number;
  label: string;
}

// Dashboard Types
export interface DashboardLayout {
  id: string;
  name: string;
  description?: string;
  layout_config: string;
  theme_config?: string;
  refresh_config?: string;
  is_public: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface DashboardLayoutConfig {
  cols: { lg: number; md: number; sm: number; xs: number };
  rowHeight: number;
  containerPadding: [number, number];
  margin: [number, number];
  layouts: {
    lg: LayoutItem[];
    md: LayoutItem[];
    sm: LayoutItem[];
    xs: LayoutItem[];
  };
}

export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  static?: boolean;
}

export interface DashboardThemeConfig {
  backgroundColor?: string;
  widgetBackgroundColor?: string;
  widgetBorderRadius?: number;
  widgetShadow?: string;
  fontFamily?: string;
}

export interface DashboardRefreshConfig {
  enabled: boolean;
  intervalSeconds: number;
  pauseOnHidden: boolean;
}

export type WidgetType = "report" | "chart" | "metric" | "text";

export interface DashboardWidget {
  id: string;
  dashboard_id: string;
  widget_type: WidgetType;
  report_id?: string;
  chart_id?: string;
  position_config: string;
  widget_config?: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfig {
  title?: string;
  showTitle?: boolean;
  showBorder?: boolean;
  backgroundColor?: string;
  padding?: number;
  overrides?: Record<string, unknown>;
}

// Job Types
export type JobType = "report" | "chart" | "export";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface JobDefinition {
  id: string;
  name: string;
  job_type: JobType;
  target_id: string;
  schedule_cron?: string;
  parameters?: string;
  notification_config?: string;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface JobExecution {
  id: string;
  job_definition_id: string;
  status: JobStatus;
  started_at?: string;
  completed_at?: string;
  result_location?: string;
  error_message?: string;
  execution_metadata?: string;
  created_at: string;
}

export interface JobNotificationConfig {
  email?: string;
  webhookUrl?: string;
}

// Permission Types
export type ResourceType =
  | "data_source"
  | "query"
  | "report"
  | "chart"
  | "filter"
  | "dashboard"
  | "dashboard_widget"
  | "job"
  | "queue"
  | "user"
  | "role"
  | "ds_role"
  | "ds_entity_permission"
  | "nl_query"
  | "metadata_entity"
  | "log"
  | "setting"
  | "monitoring_rule"
  | "monitoring_execution"
  | "adk_intent"
  | "queries"
  | "dashboard_filters"
  | "nl_builder"
  | "rag_context"
  | "schema_table_instruction"
  | "schema_field_instruction";

export type PermissionLevel = "view" | "edit" | "execute" | "admin";

export interface ResourcePermission {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  role_id: string;
  permission_level: PermissionLevel;
  created_at: string;
}

// Audit Types
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "view"
  | "export"
  | "retry"
  | "pause"
  | "resume"
  | "clean"
  | "monitoring:rule_created"
  | "monitoring:rule_updated"
  | "monitoring:rule_deleted"
  | "monitoring:rule_paused"
  | "monitoring:rule_resumed"
  | "monitoring:rule_executed"
  | "monitoring:breach_detected"
  | "monitoring:escalation_detected"
  | "monitoring:alert_dispatched"
  | "monitoring:no_data"
  | "monitoring:rbac_drift_detected"
  | "monitoring:rbac_revoked"
  | "adk:intent_received"
  | "adk:intent_classified"
  | "adk:pipeline_started"
  | "adk:pipeline_completed"
  | "chat:delegated_sign_in"
  | "adk:pipeline_failed"
  | "adk:schema_introspected"
  | "adk:sql_generated"
  | "adk:rule_persisted"
  | "adk:clarification_requested"
  | "report:generated"
  | "report:permission_revoked"
  | "report:failed"
  | "report:scheduled"
  | "batch_execute"
  | "email_batch"
  | "inspect"
  | "preview"
  | "sql_validation_warning"
  | "openkb_query_logged"
  | "openkb_suggestions_requested";

export interface AuditLog {
  id: string;
  user_id?: string;
  action: AuditAction;
  resource_type: ResourceType;
  resource_id?: string;
  details?: string;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

// Data Source RBAC Types
export type DsEntityPermissionLevel = "select" | "insert" | "update" | "delete" | "all";
export type DsEntityType = "table" | "view";
export type NlAccessCheckResult = "granted" | "denied" | "pending" | "error";

export interface DsRole {
  id: string;
  data_source_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface DsUserRole {
  data_source_id: string;
  user_id: string;
  ds_role_id: string;
  assigned_at: string;
}

export interface DsEntityPermission {
  id: string;
  data_source_id: string;
  ds_role_id: string;
  entity_name: string;
  entity_type: DsEntityType;
  entity_schema?: string;
  permission_level: DsEntityPermissionLevel;
  column_restrictions?: string; // JSON array of allowed columns
  row_filter?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface DsSchemaCache {
  id: string;
  data_source_id: string;
  schema_metadata: string; // JSON
  sample_data?: string; // JSON
  embedding_data?: string; // JSON
  last_introspected_at: string;
  created_at: string;
  updated_at: string;
}

export interface NlQueryHistory {
  id: string;
  data_source_id: string;
  user_id: string;
  natural_language_query: string;
  generated_sql?: string;
  parsed_entities?: string; // JSON
  access_check_result: NlAccessCheckResult;
  access_check_details?: string; // JSON
  execution_result?: string; // JSON
  error_message?: string;
  execution_time_ms?: number;
  created_at: string;
}

// Parsed SQL entity reference (from ANTLR parsing)
export interface ParsedSqlEntity {
  name: string;
  schema?: string;
  alias?: string;
  type: "table" | "view" | "subquery";
}

// Access check result detail
export interface AccessCheckDetail {
  entity: string;
  entitySchema?: string;
  hasAccess: boolean;
  grantedBy?: string; // role name that grants access
  permissionLevel?: DsEntityPermissionLevel;
  columnRestrictions?: string[];
  rowFilter?: string;
}

// NL Query execution pipeline result
export interface NlQueryPipelineResult {
  naturalLanguageQuery: string;
  generatedSql: string;
  parsedEntities: ParsedSqlEntity[];
  accessCheckResults: AccessCheckDetail[];
  accessGranted: boolean;
  queryResults?: {
    columns: string[];
    rows: Record<string, unknown>[];
    totalRows: number;
    executionTimeMs: number;
  };
  error?: string;
}

// Data source user-role join result
export interface DsUserRoleJoinRow extends DsUserRole {
  user_email?: string;
  user_display_name?: string;
  role_name?: string;
}

// Join result for user roles with permissions
export interface UserRolePermissionRow {
  permissions: string;
}

// Join result for DS user roles with role info
export interface DsUserRoleWithRoleInfo {
  role_id: string;
  role_name: string;
}

// Frontend API response shapes for NL Query workspace
export interface DataSourceListItem {
  id: string;
  name: string;
  client_type: string;
  description?: string;
  is_active: boolean;
}

export interface SchemaOverviewResponse {
  tableCount: number;
  viewCount: number;
  tables: SchemaTableSummary[];
  schemaText: string;
}

export interface SchemaTableSummary {
  name: string;
  columnCount: number;
  columns: SchemaColumnSummary[];
}

export interface SchemaColumnSummary {
  name: string;
  type: string;
}

export interface QueryHistoryEntry {
  id: string;
  data_source_id: string;
  user_id: string;
  natural_language_query: string;
  generated_sql?: string;
  parsed_entities?: string;
  access_check_result: NlAccessCheckResult;
  access_check_details?: string;
  execution_result?: string;
  error_message?: string;
  execution_time_ms?: number;
  created_at: string;
}

// Chart configuration for NL results visualization
export interface NlChartConfig {
  chartType: "bar" | "line" | "area" | "pie" | "scatter";
  title: string;
  xAxis: { field: string; label: string };
  yAxis: { field: string; label: string }[];
  colors?: string[];
}

// SQL AST node types for sql-parser.ts traversal
// These match the actual runtime shapes from node-sql-parser's AST output
export interface SqlAstNode {
  type?: string;
  from?: SqlFromItem[];
  where?: SqlExpression;
  having?: SqlExpression;
  table?: SqlTableRef[] | SqlTableRef;
  _next?: SqlAstNode;
  [key: string]: unknown;
}

export interface SqlFromItem {
  table?: string;
  db?: string;
  as?: string;
  expr?: SqlAstNode;
  [key: string]: unknown;
}

export interface SqlTableRef {
  table?: string;
  db?: string;
  as?: string;
  [key: string]: unknown;
}

export interface SqlExpression {
  type?: string;
  [key: string]: unknown;
}

// Schema data response from existing schema API
export interface SchemaApiResponse {
  tables: { name: string; columns: SchemaColumnSummary[] }[];
  views?: { name: string; columns: SchemaColumnSummary[] }[];
}

// User list item (for admin user listing in permissions page)
export interface UserListItem {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
}

// ============================================================================
// Metadata Entity Registry Types
// ============================================================================

/**
 * Metadata Entity Header
 * Stores entity-level metadata for tables and views discovered from datasources.
 */
export interface MetadataEntityHeader {
  id: string;
  data_source_id: string;
  entity_name: string;
  entity_schema?: string;
  entity_type: "table" | "view";
  description?: string;
  schema_metadata: string; // JSON
  is_active: boolean;
  is_hidden: boolean;
  last_introspected_at: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Metadata Entity Field
 * Stores field-level metadata for columns within entities.
 */
export interface MetadataEntityField {
  id: string;
  entity_header_id: string;
  field_name: string;
  data_type: string;
  // Nullable in metadata_entity_field; the booleans carry defaults but no NOT NULL.
  is_nullable: boolean | null;
  is_primary_key: boolean | null;
  is_foreign_key: boolean | null;
  foreign_key_table?: string | null;
  foreign_key_column?: string | null;
  default_value?: string | null;
  description?: string | null;
  is_display_field: boolean | null;
  is_searchable: boolean | null;
  display_order?: number | null;
  section_name?: string | null; // Group fields into visual sections
  relationship_ui_type?: "dropdown" | "popup" | "tab" | null; // FK UI configuration
  created_at: string;
  updated_at: string;
}

/**
 * Entity with Fields (API response)
 * Complete entity metadata including all fields
 */
/**
 * A row from GET /api/metadata/entities: the header plus the joined data source
 * name and field count the listing shows.
 */
export interface MetadataEntityListRow extends MetadataEntityHeader {
  data_source_name?: string | null;
  field_count?: number;
}

export interface MetadataEntityWithFields extends MetadataEntityHeader {
  fields: MetadataEntityField[];
  data_source_name?: string;
  permissions?: ResourcePermission[];
}

/**
 * Entity Schema Metadata (JSON structure in schema_metadata field)
 */
export interface EntitySchemaMetadata {
  tableName: string;
  schema?: string;
  entityType: "table" | "view";
  primaryKey?: string[];
  foreignKeys?: Array<{
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
  }>;
  indexes?: Array<{
    name: string;
    columns: string[];
    unique: boolean;
  }>;
  columns?: Array<{
    name: string;
    type: string;
    nullable: boolean;
    defaultValue?: SerializableValue;
  }>;
}

/**
 * List/Filter parameters for metadata entities
 */
export interface MetadataEntityListParams {
  data_source_id?: string;
  is_active?: boolean;
  is_hidden?: boolean;
  include_hidden?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Schema and Query Result types (moved from wasm.ts)
// ---------------------------------------------------------------------------

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableSchema {
  tableName: string;
  columns: ColumnSchema[];
  rowCount?: number;
}

export interface QueryResult {
  /** Result rows as plain objects */
  rows: Record<string, unknown>[];
  /** Number of rows */
  rowCount: number;
  /** Column schema */
  columns: ColumnSchema[];
  /** Execution time in ms */
  executionTime: number;
  /** The SQL that was executed */
  query: string;
}

/**
 * A value that survives TanStack Start's server-function serializer.
 *
 * `Record<string, unknown>` does not: `unknown` matches none of the serializer's
 * branches, so it resolves to SerializationError and the whole server function
 * fails to type-check. Query results are scalars, so naming them is enough.
 */
export type SerializableValue = string | number | boolean | null | undefined | Date;

/** One row of a SQL result, as returned across a server-function boundary. */
export type ResultRow = Record<string, SerializableValue>;
