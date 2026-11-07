/**
 * Monitoring Worker
 *
 * Core execution logic for the monitoring:evaluate Trigger.dev task.
 * Loads a monitoring rule, validates RBAC, runs the report SQL, evaluates
 * the threshold, dispatches alerts, and records the execution.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/config";

function isoNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
import { getConnection } from "@/lib/db/connection-manager";
import { decrypt } from "@/lib/security/encryption";
import { logAudit } from "@/lib/security/audit";
import { createNotification } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/email-service";
import type {
  MonitoringRule,
  MonitoringExecution,
  ThresholdEvaluation,
  AlertDispatchResult,
  RBACDriftResult,
  MonitoringEvaluatePayload,
  AlertRecipient,
  AlertChannel,
} from "@/types/monitoring";
import { getLogger } from "@/lib/logging/logger";

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** RFC-1918 / loopback SSRF guard for webhook URLs */
function isPrivateOrLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Loopback
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^127\./.test(host)) return true;

    // 10.x.x.x
    if (/^10\./.test(host)) return true;

    // 172.16.x.x – 172.31.x.x
    const m172 = host.match(/^172\.(\d+)\./);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;

    // 192.168.x.x
    if (/^192\.168\./.test(host)) return true;

    // Link-local
    if (/^169\.254\./.test(host)) return true;

    return false;
  } catch {
    return true; // treat unparseable URLs as unsafe
  }
}

// ────────────────────────────────────────────────────────────────────────────
// loadMonitoringRule
// ────────────────────────────────────────────────────────────────────────────

export async function loadMonitoringRule(ruleId: string): Promise<MonitoringRule | null> {
  const db = getDb();
  const row = await (db as any)
    .selectFrom("monitoring_rules")
    .selectAll()
    .where("id", "=", ruleId)
    .executeTakeFirst();

  if (!row) return null;

  return {
    ...row,
    threshold_value: Number(row.threshold_value),
    threshold_upper_bound:
      row.threshold_upper_bound != null ? Number(row.threshold_upper_bound) : null,
    escalation_threshold_pct: Number(row.escalation_threshold_pct ?? 20),
    last_metric_value: row.last_metric_value != null ? Number(row.last_metric_value) : null,
    consecutive_breaches: Number(row.consecutive_breaches ?? 0),
    total_executions: Number(row.total_executions ?? 0),
    total_alerts_sent: Number(row.total_alerts_sent ?? 0),
    is_active: Boolean(row.is_active),
    is_paused: Boolean(row.is_paused),
    notify_on_pass: Boolean(row.notify_on_pass),
    notify_on_no_data: Boolean(row.notify_on_no_data),
    alert_channels: safeParseJson<AlertChannel[]>(row.alert_channels, []),
    alert_recipients: safeParseJson<AlertRecipient[]>(row.alert_recipients, []),
    rbac_snapshot: safeParseJson(row.rbac_snapshot, {
      userId: row.created_by,
      roles: [],
      dataSourceId: row.data_source_id,
      capturedAt: row.created_at,
    }),
  } as MonitoringRule;
}

// ────────────────────────────────────────────────────────────────────────────
// validateRBACForExecution
// ────────────────────────────────────────────────────────────────────────────

export async function validateRBACForExecution(
  userId: string,
  dataSourceId: string
): Promise<RBACDriftResult> {
  const db = getDb();

  // 1. Check if user is still active
  const user = await db
    .selectFrom("users")
    .select(["id", "is_active"])
    .where("id", "=", userId)
    .executeTakeFirst();

  if (!user || !user.is_active) {
    return {
      driftType: "PERMISSION_REVOKED",
      canProceed: false,
      details: `User ${userId} is no longer active`,
    };
  }

  // 2. Gather all role IDs for this user
  const userRoleRows = await db
    .selectFrom("user_roles")
    .select("role_id")
    .where("user_id", "=", userId)
    .execute();

  const roleIds = userRoleRows.map((r) => r.role_id);

  if (roleIds.length === 0) {
    return {
      driftType: "PERMISSION_REVOKED",
      canProceed: false,
      details: `User ${userId} has no roles assigned`,
    };
  }

  // 3. Check if any role is admin — admins always proceed
  const adminRoles = await db
    .selectFrom("roles")
    .select(["id", "name"])
    .where("id", "in", roleIds)
    .execute();

  const hasAdminRole = adminRoles.some((r) => {
    const n = r.name.toLowerCase();
    return n === "admin" || n === "administrator" || n.startsWith("admin");
  });
  if (hasAdminRole) {
    return { driftType: "NO_DRIFT", canProceed: true, details: "Admin role" };
  }

  // 4. Check resource_permissions for this data source
  const permission = await (db as any)
    .selectFrom("resource_permissions")
    .select(["permission_level"])
    .where("resource_type", "=", "data_source")
    .where("resource_id", "=", dataSourceId)
    .where("role_id", "in", roleIds)
    .executeTakeFirst();

  if (!permission) {
    return {
      driftType: "PERMISSION_REVOKED",
      canProceed: false,
      details: `No resource permission found for data source ${dataSourceId}`,
    };
  }

  const levelHierarchy = ["view", "edit", "execute", "admin"];
  const grantedIndex = levelHierarchy.indexOf(permission.permission_level);
  const executeIndex = levelHierarchy.indexOf("execute");

  if (grantedIndex < executeIndex) {
    return {
      driftType: "PERMISSION_REVOKED",
      canProceed: false,
      details: `Permission level '${permission.permission_level}' is insufficient (need execute or admin)`,
    };
  }

  return { driftType: "NO_DRIFT", canProceed: true, details: "Sufficient permission" };
}

// ────────────────────────────────────────────────────────────────────────────
// executeReportSQL
// ────────────────────────────────────────────────────────────────────────────

export async function executeReportSQL(
  rule: MonitoringRule
): Promise<{ rows: Record<string, unknown>[]; executionMs: number; sql: string }> {
  const db = getDb();
  const startTime = Date.now();

  // Load the report definition to get the saved_query_id
  const reportDef = await (db as any)
    .selectFrom("report_definitions")
    .select(["id", "saved_query_id"])
    .where("id", "=", rule.report_definition_id)
    .executeTakeFirst();

  if (!reportDef?.saved_query_id) {
    // Report definition missing or has no saved query — return empty rows so
    // threshold evaluation produces NO_DATA rather than crashing the pipeline.
    const executionMs = Date.now() - startTime;
    getLogger("jobs").note("warn", `[monitoring-worker] Report definition ${rule.report_definition_id} has no associated saved query — producing NO_DATA`);
    return { rows: [], executionMs, sql: "" };
  }

  // Load the saved query to get SQL and data_source_id
  const savedQuery = await db
    .selectFrom("saved_queries")
    .select(["id", "sql_content", "data_source_id"])
    .where("id", "=", reportDef.saved_query_id)
    .executeTakeFirst();

  if (!savedQuery) {
    const executionMs = Date.now() - startTime;
    getLogger("jobs").note("warn", `[monitoring-worker] Saved query ${reportDef.saved_query_id} not found — producing NO_DATA`);
    return { rows: [], executionMs, sql: "" };
  }

  const sqlContent = savedQuery.sql_content;

  // Load data source for connection
  const dataSourceRow = await db
    .selectFrom("data_sources")
    .selectAll()
    .where("id", "=", rule.data_source_id)
    .where("is_active", "=", true)
    .executeTakeFirst();

  if (!dataSourceRow) {
    throw new Error(`Data source ${rule.data_source_id} not found or inactive`);
  }

  // Use connection-manager which handles decryption internally
  const conn = await getConnection(dataSourceRow as any);

  try {
    // Execute with row limit guard — wrap in a subquery to enforce LIMIT 10000
    const limitedSql = `SELECT * FROM (${sqlContent}) AS __monitoring_subquery__ LIMIT 10000`;

    // Use sql template tag for raw execution
    const { sql: kyselySql } = await import("kysely");

    const result = await kyselySql.raw(limitedSql).execute(conn);

    const rows = (result.rows as Record<string, unknown>[]) ?? [];
    const executionMs = Date.now() - startTime;

    return { rows, executionMs, sql: sqlContent };
  } catch (error) {
    const executionMs = Date.now() - startTime;
    getLogger("jobs").note("error", "[monitoring-worker] executeReportSQL failed:", { err: error });
    // Return empty rows — evaluation will produce NO_DATA status
    return { rows: [], executionMs, sql: sqlContent };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// evaluateThreshold
// ────────────────────────────────────────────────────────────────────────────

export function evaluateThreshold(
  rows: Record<string, unknown>[],
  rule: MonitoringRule,
  previousValue?: number
): ThresholdEvaluation {
  const base: Omit<ThresholdEvaluation, "status" | "breachSeverity" | "message"> = {
    actualValue: null,
    thresholdValue: rule.threshold_value,
    operator: rule.threshold_operator,
    deltaFromPrevious: undefined,
  };

  if (rows.length === 0) {
    return { ...base, status: "NO_DATA", message: "No data returned from report query" };
  }

  // Find the metric column value (case-insensitive)
  const firstRow = rows[0];
  const colKey = Object.keys(firstRow).find(
    (k) => k.toLowerCase() === rule.metric_column.toLowerCase()
  );

  if (!colKey) {
    return {
      ...base,
      status: "NO_DATA",
      message: `Metric column '${rule.metric_column}' not found in result (available: ${Object.keys(firstRow).join(", ")})`,
    };
  }

  const rawValue = firstRow[colKey];
  const actualValue = typeof rawValue === "number" ? rawValue : Number(rawValue);

  if (Number.isNaN(actualValue)) {
    return {
      ...base,
      status: "NO_DATA",
      message: `Metric column '${rule.metric_column}' value '${String(rawValue)}' could not be parsed as a number`,
    };
  }

  // Delta from previous
  const deltaFromPrevious =
    previousValue != null && previousValue !== 0
      ? ((actualValue - previousValue) / Math.abs(previousValue)) * 100
      : undefined;

  // Evaluate operator
  const threshold = rule.threshold_value;
  const upperBound = rule.threshold_upper_bound;

  let conditionBreach = false;
  switch (rule.threshold_operator) {
    case "gt":
      conditionBreach = actualValue > threshold;
      break;
    case "gte":
      conditionBreach = actualValue >= threshold;
      break;
    case "lt":
      conditionBreach = actualValue < threshold;
      break;
    case "lte":
      conditionBreach = actualValue <= threshold;
      break;
    case "eq":
      conditionBreach = actualValue === threshold;
      break;
    case "neq":
      conditionBreach = actualValue !== threshold;
      break;
    case "between":
      if (upperBound != null) {
        conditionBreach = !(actualValue >= threshold && actualValue <= upperBound);
      } else {
        conditionBreach = actualValue < threshold;
      }
      break;
    default:
      conditionBreach = false;
  }

  if (!conditionBreach) {
    return {
      actualValue,
      thresholdValue: threshold,
      operator: rule.threshold_operator,
      deltaFromPrevious,
      status: "PASS",
      message: `Metric value ${actualValue} satisfies threshold condition (${rule.threshold_operator} ${threshold})`,
    };
  }

  // Compute deviation percentage from threshold
  const deviationPct =
    threshold !== 0 ? Math.abs(((actualValue - threshold) / Math.abs(threshold)) * 100) : null;

  const escalationPct = rule.escalation_threshold_pct ?? 20;
  const isEscalation = deviationPct != null && deviationPct > escalationPct;

  if (isEscalation) {
    return {
      actualValue,
      thresholdValue: threshold,
      operator: rule.threshold_operator,
      deltaFromPrevious,
      status: "ESCALATE",
      breachSeverity: "CRITICAL",
      message: `CRITICAL: Metric value ${actualValue} breaches threshold (${rule.threshold_operator} ${threshold}) by ${deviationPct!.toFixed(1)}% — exceeds escalation threshold of ${escalationPct}%`,
    };
  }

  return {
    actualValue,
    thresholdValue: threshold,
    operator: rule.threshold_operator,
    deltaFromPrevious,
    status: "BREACH",
    breachSeverity: "WARNING",
    message: `WARNING: Metric value ${actualValue} breaches threshold (${rule.threshold_operator} ${threshold})${deviationPct != null ? ` by ${deviationPct.toFixed(1)}%` : ""}`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// dispatchAlerts
// ────────────────────────────────────────────────────────────────────────────

async function resolveRecipientEmails(
  recipients: AlertRecipient[]
): Promise<{ userId: string; email: string }[]> {
  if (recipients.length === 0) return [];

  const db = getDb();
  const resolved: { userId: string; email: string }[] = [];

  const userIds = recipients.filter((r) => r.type === "user").map((r) => r.id);
  const roleIds = recipients.filter((r) => r.type === "role").map((r) => r.id);

  // Direct user recipients
  if (userIds.length > 0) {
    const users = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("id", "in", userIds)
      .where("is_active", "=", true)
      .execute();

    for (const u of users) {
      resolved.push({ userId: u.id, email: u.email });
    }
  }

  // Role-based recipients — look up all users in those roles
  if (roleIds.length > 0) {
    const roleRecords = await db
      .selectFrom("roles")
      .select(["id"])
      .where("id", "in", roleIds)
      .execute();

    const validRoleIds = roleRecords.map((r) => r.id);
    if (validRoleIds.length > 0) {
      const userRoleRows = await db
        .selectFrom("user_roles")
        .select("user_id")
        .where("role_id", "in", validRoleIds)
        .execute();

      const roleUserIds = [...new Set(userRoleRows.map((r) => r.user_id))];
      if (roleUserIds.length > 0) {
        const roleUsers = await db
          .selectFrom("users")
          .select(["id", "email"])
          .where("id", "in", roleUserIds)
          .where("is_active", "=", true)
          .execute();

        for (const u of roleUsers) {
          if (!resolved.find((r) => r.userId === u.id)) {
            resolved.push({ userId: u.id, email: u.email });
          }
        }
      }
    }
  }

  return resolved;
}

export async function dispatchAlerts(
  rule: MonitoringRule,
  evaluation: ThresholdEvaluation,
  executionId: string
): Promise<AlertDispatchResult[]> {
  const results: AlertDispatchResult[] = [];
  const resolvedUsers = await resolveRecipientEmails(rule.alert_recipients);

  const alertPayload = {
    ruleId: rule.id,
    ruleName: rule.name,
    executionId,
    status: evaluation.status,
    severity: evaluation.breachSeverity,
    actualValue: evaluation.actualValue,
    thresholdValue: evaluation.thresholdValue,
    message: evaluation.message,
    triggeredAt: new Date().toISOString(),
  };

  for (const channel of rule.alert_channels) {
    if (channel === "email") {
      const emails = resolvedUsers.map((u) => u.email).filter(Boolean);
      if (emails.length === 0) {
        results.push({
          channel: "email",
          success: false,
          recipientCount: 0,
          error: "No email recipients resolved",
        });
        continue;
      }

      const severityLabel = evaluation.breachSeverity === "CRITICAL" ? "CRITICAL" : "WARNING";
      const emailTemplate = {
        subject: `[${severityLabel}] Monitoring Alert: ${rule.name}`,
        htmlBody: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: ${evaluation.breachSeverity === "CRITICAL" ? "#dc2626" : "#d97706"}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
    .metric-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid ${evaluation.breachSeverity === "CRITICAL" ? "#dc2626" : "#d97706"}; }
    .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; background: ${evaluation.breachSeverity === "CRITICAL" ? "#fee2e2" : "#fef3c7"}; color: ${evaluation.breachSeverity === "CRITICAL" ? "#991b1b" : "#92400e"}; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Monitoring Alert: {{ruleName}}</h1></div>
    <div class="content">
      <p>A monitoring threshold has been breached for rule <strong>{{ruleName}}</strong>.</p>
      <div class="metric-box">
        <p><strong>Status:</strong> <span class="badge">{{status}}</span></p>
        <p><strong>Metric Value:</strong> {{actualValue}}</p>
        <p><strong>Threshold:</strong> {{thresholdValue}}</p>
        {{#if deviationPct}}<p><strong>Deviation:</strong> {{deviationPct}}%</p>{{/if}}
        <p><strong>Message:</strong> {{message}}</p>
        <p><strong>Triggered At:</strong> {{triggeredAt}}</p>
      </div>
    </div>
    <div class="footer"><p>Enterprise Reporting System — Monitoring</p></div>
  </div>
</body>
</html>`,
      };

      const emailResult = await sendEmail(emails, emailTemplate, {
        ruleName: rule.name,
        status: evaluation.status,
        actualValue: String(evaluation.actualValue ?? "N/A"),
        thresholdValue: String(evaluation.thresholdValue),
        deviationPct:
          evaluation.deltaFromPrevious != null ? evaluation.deltaFromPrevious.toFixed(1) : "",
        message: evaluation.message,
        triggeredAt: alertPayload.triggeredAt,
      });

      results.push({
        channel: "email",
        success: emailResult.success,
        recipientCount: emails.length,
        error: emailResult.error,
        messageId: emailResult.messageId,
      });
    } else if (channel === "in_app") {
      const userIds = resolvedUsers.map((u) => u.userId);
      if (userIds.length === 0) {
        results.push({
          channel: "in_app",
          success: false,
          recipientCount: 0,
          error: "No in-app recipients resolved",
        });
        continue;
      }

      let successCount = 0;
      let lastError: string | undefined;

      for (const uid of userIds) {
        try {
          await createNotification({
            userId: uid,
            type: evaluation.breachSeverity === "CRITICAL" ? "error" : "warning",
            title: `Monitoring Alert: ${rule.name}`,
            message: evaluation.message,
            metadata: alertPayload,
          });
          successCount++;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      results.push({
        channel: "in_app",
        success: successCount > 0,
        recipientCount: successCount,
        error: lastError,
      });
    } else if (channel === "webhook") {
      if (!rule.webhook_url) {
        results.push({
          channel: "webhook",
          success: false,
          recipientCount: 0,
          error: "No webhook URL configured",
        });
        continue;
      }

      if (isPrivateOrLoopback(rule.webhook_url)) {
        results.push({
          channel: "webhook",
          success: false,
          recipientCount: 0,
          error: "Webhook URL resolves to a private/loopback address (SSRF blocked)",
        });
        continue;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(rule.webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "enterprise-reporting-monitor/1.0",
          },
          body: JSON.stringify(alertPayload),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        if (!response.ok) {
          results.push({
            channel: "webhook",
            success: false,
            recipientCount: 0,
            error: `Webhook returned HTTP ${response.status}`,
          });
        } else {
          results.push({ channel: "webhook", success: true, recipientCount: 1 });
        }
      } catch (err) {
        results.push({
          channel: "webhook",
          success: false,
          recipientCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// recordExecution
// ────────────────────────────────────────────────────────────────────────────

export async function recordExecution(data: {
  ruleId: string;
  status: ThresholdEvaluation["status"];
  metricValue: number | null;
  previousValue: number | null;
  deltaP: number | undefined;
  rows: number;
  executionMs: number;
  sql: string;
  alertDispatched: boolean;
  alertChannels: string[];
  alertRecipients: string[];
  error?: string;
  errorPhase?: string;
}): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const now = isoNow();

  await (db as any)
    .insertInto("monitoring_executions")
    .values({
      id,
      monitoring_rule_id: data.ruleId,
      executed_at: now,
      execution_ms: data.executionMs,
      rows_returned: data.rows,
      sql_executed: data.sql.slice(0, 65535), // guard against TEXT column limit
      metric_value: data.metricValue,
      previous_metric_value: data.previousValue,
      delta_pct: data.deltaP ?? null,
      evaluation_status: data.status,
      evaluation_detail: null,
      alert_dispatched: data.alertDispatched ? 1 : 0,
      alert_channels_used: JSON.stringify(data.alertChannels),
      alert_recipients_sent: JSON.stringify(data.alertRecipients),
      alert_sent_at: data.alertDispatched ? now : null,
      error_message: data.error ?? null,
      error_phase: data.errorPhase ?? null,
      created_at: now,
    })
    .execute();

  return id;
}

// ────────────────────────────────────────────────────────────────────────────
// executeMonitoringEvaluation — main orchestrator
// ────────────────────────────────────────────────────────────────────────────

export async function executeMonitoringEvaluation(
  payload: MonitoringEvaluatePayload
): Promise<{ status: string; metricValue?: number | null; error?: string }> {
  const startTime = Date.now();
  const db = getDb();

  // ── Phase 1: Load rule ───────────────────────────────────────────────────
  const rule = await loadMonitoringRule(payload.ruleId);
  if (!rule) {
    throw new Error(`Monitoring rule ${payload.ruleId} not found`);
  }

  if (!rule.is_active || rule.is_paused) {
    return { status: "SKIPPED", metricValue: null };
  }

  // ── Phase 2: RBAC validation ─────────────────────────────────────────────
  const ruleOwnerId = rule.created_by;
  const rbacResult = await validateRBACForExecution(ruleOwnerId, rule.data_source_id);

  if (!rbacResult.canProceed) {
    // Pause the rule automatically
    await (db as any)
      .updateTable("monitoring_rules")
      .set({
        is_paused: 1,
        pause_reason: `RBAC drift detected: ${rbacResult.driftType} — ${rbacResult.details ?? ""}`,
        updated_at: isoNow(),
      })
      .where("id", "=", rule.id)
      .execute();

    // Dispatch in-app access alert to rule creator (best-effort)
    try {
      await createNotification({
        userId: rule.created_by,
        type: "error",
        title: `Monitoring Rule Paused: ${rule.name}`,
        message: `Rule paused due to permission change (${rbacResult.driftType}): ${rbacResult.details ?? "Access revoked"}`,
        metadata: { ruleId: rule.id, driftType: rbacResult.driftType },
      });
    } catch {
      // Non-fatal
    }

    await logAudit({
      userId: ruleOwnerId,
      action: "execute",
      resourceType: "data_source",
      resourceId: rule.data_source_id,
      details: {
        operation: "monitoring_rbac_drift",
        ruleId: rule.id,
        driftType: rbacResult.driftType,
        detail: rbacResult.details,
      },
    });

    return { status: "RBAC_DRIFT", metricValue: null };
  }

  // ── Phase 3: Previous execution value ────────────────────────────────────
  const prevExecution = await (db as any)
    .selectFrom("monitoring_executions")
    .select(["metric_value"])
    .where("monitoring_rule_id", "=", rule.id)
    .orderBy("executed_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const previousValue: number | undefined =
    prevExecution?.metric_value != null ? Number(prevExecution.metric_value) : undefined;

  // ── Phase 4: Execute report SQL ──────────────────────────────────────────
  let sqlResult: { rows: Record<string, unknown>[]; executionMs: number; sql: string };
  let sqlError: string | undefined;

  try {
    sqlResult = await executeReportSQL(rule);
  } catch (err) {
    sqlError = err instanceof Error ? err.message : String(err);
    sqlResult = { rows: [], executionMs: Date.now() - startTime, sql: "" };
  }

  // ── Phase 5: Evaluate threshold ──────────────────────────────────────────
  const evaluation = evaluateThreshold(sqlResult.rows, rule, previousValue);

  // Override status to ERROR if SQL execution threw
  if (sqlError) {
    evaluation.status = "ERROR" as typeof evaluation.status;
    evaluation.message = `SQL execution failed: ${sqlError}`;
  }

  // ── Phase 6: Dispatch alerts ─────────────────────────────────────────────
  let alertDispatched = false;
  let alertResults: AlertDispatchResult[] = [];
  const shouldAlert =
    evaluation.status === "BREACH" ||
    evaluation.status === "ESCALATE" ||
    (evaluation.status === "PASS" && rule.notify_on_pass) ||
    (evaluation.status === "NO_DATA" && rule.notify_on_no_data);

  if (shouldAlert && rule.alert_channels.length > 0) {
    try {
      const executionId = randomUUID(); // placeholder — real ID assigned in recordExecution
      alertResults = await dispatchAlerts(rule, evaluation, executionId);
      alertDispatched = alertResults.some((r) => r.success);
    } catch (err) {
      getLogger("jobs").note("error", "[monitoring-worker] dispatchAlerts failed:", { err: err });
    }
  }

  // ── Phase 7: Record execution ─────────────────────────────────────────────
  const channelsUsed = [...new Set(alertResults.filter((r) => r.success).map((r) => r.channel))];

  await recordExecution({
    ruleId: rule.id,
    status: evaluation.status,
    metricValue: evaluation.actualValue,
    previousValue: previousValue ?? null,
    deltaP: evaluation.deltaFromPrevious,
    rows: sqlResult.rows.length,
    executionMs: sqlResult.executionMs,
    sql: sqlResult.sql,
    alertDispatched,
    alertChannels: channelsUsed,
    alertRecipients: rule.alert_recipients.map((r) => r.id),
    error: sqlError,
    errorPhase: sqlError ? "sql_execution" : undefined,
  });

  // ── Phase 8: Update rule stats ────────────────────────────────────────────
  const isBreachOrEscalate = evaluation.status === "BREACH" || evaluation.status === "ESCALATE";
  const newConsecutiveBreaches = isBreachOrEscalate ? rule.consecutive_breaches + 1 : 0;

  await (db as any)
    .updateTable("monitoring_rules")
    .set({
      total_executions: rule.total_executions + 1,
      last_executed_at: isoNow(),
      last_execution_status: evaluation.status,
      last_metric_value: evaluation.actualValue,
      consecutive_breaches: newConsecutiveBreaches,
      total_alerts_sent: alertDispatched
        ? rule.total_alerts_sent + alertResults.filter((r) => r.success).length
        : rule.total_alerts_sent,
      updated_at: isoNow(),
    })
    .where("id", "=", rule.id)
    .execute();

  // ── Phase 9: Audit log ────────────────────────────────────────────────────
  await logAudit({
    userId: ruleOwnerId,
    action: "execute",
    resourceType: "data_source",
    resourceId: rule.data_source_id,
    details: {
      operation: "monitoring_evaluation",
      ruleId: rule.id,
      ruleName: rule.name,
      status: evaluation.status,
      metricValue: evaluation.actualValue,
      alertDispatched,
      triggeredBy: payload.triggeredBy ?? "schedule",
    },
  });

  // ── Phase 10: Return result ───────────────────────────────────────────────
  return {
    status: evaluation.status,
    metricValue: evaluation.actualValue,
    error: sqlError,
  };
}
