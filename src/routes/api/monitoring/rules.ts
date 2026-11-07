import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { resolveRBACContext } from "@/lib/monitoring/rbac-workflow-context";
import { scheduleMonitoringRule } from "@/lib/monitoring/monitoring-scheduler";
import { logAudit } from "@/lib/security/audit";
import { AUDIT_ACTIONS } from "@/types/actions";
import type { AlertChannel, AlertRecipient, ThresholdOperator } from "@/types/monitoring";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deserializeRule(row: Record<string, unknown>) {
  const isActive = Boolean(row.is_active);
  const isPaused = Boolean(row.is_paused);
  const status = isPaused ? "paused" : isActive ? "active" : "error";
  return {
    ...row,
    alert_channels: parseJsonColumn<AlertChannel[]>(row.alert_channels, []),
    alert_recipients: parseJsonColumn<AlertRecipient[]>(row.alert_recipients, []),
    rbac_snapshot: parseJsonColumn(row.rbac_snapshot, {}),
    notify_on_pass: Boolean(row.notify_on_pass),
    notify_on_no_data: Boolean(row.notify_on_no_data),
    is_active: isActive,
    is_paused: isPaused,
    status,
    schedule_cron: row.cron_expression,
    last_run_at: row.last_executed_at ?? null,
    threshold_value: Number(row.threshold_value),
    threshold_upper_bound:
      row.threshold_upper_bound != null ? Number(row.threshold_upper_bound) : undefined,
    escalation_threshold_pct: Number(row.escalation_threshold_pct ?? 20),
  };
}

export const Route = createFileRoute("/api/monitoring/rules")({
  server: {
    handlers: {
      GET: withApiHandler("/api/monitoring/rules", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

          const url = new URL(request.url);
          const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
          const pageSize = Math.min(
            100,
            Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10))
          );
          const statusFilter = url.searchParams.get("status") ?? "active";
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));
          const db = getDb();

          let query = (db as any)
            .selectFrom("monitoring_rules")
            .leftJoin("data_sources", "data_sources.id", "monitoring_rules.data_source_id");
          if (!isAdmin) query = query.where("monitoring_rules.created_by", "=", session.user.id);
          if (statusFilter === "active") {
            query = query
              .where("monitoring_rules.is_active", "=", true)
              .where("monitoring_rules.is_paused", "=", false);
          } else if (statusFilter === "paused") {
            query = query.where("monitoring_rules.is_paused", "=", true);
          }

          const totalRow = (await (db as any)
            .selectFrom("monitoring_rules")
            .select((db as any).fn.count("monitoring_rules.id").as("count"))
            .executeTakeFirst()) as { count: number } | undefined;
          const total = Number(totalRow?.count ?? 0);

          const rules = (await query
            .select([
              "monitoring_rules.id",
              "monitoring_rules.name",
              "monitoring_rules.description",
              "monitoring_rules.data_source_id",
              "data_sources.name as data_source_name",
              "monitoring_rules.metric_column",
              "monitoring_rules.threshold_operator",
              "monitoring_rules.threshold_value",
              "monitoring_rules.threshold_upper_bound",
              "monitoring_rules.escalation_threshold_pct",
              "monitoring_rules.cron_expression",
              "monitoring_rules.timezone",
              "monitoring_rules.alert_channels",
              "monitoring_rules.alert_recipients",
              "monitoring_rules.webhook_url",
              "monitoring_rules.notify_on_pass",
              "monitoring_rules.notify_on_no_data",
              "monitoring_rules.is_active",
              "monitoring_rules.is_paused",
              "monitoring_rules.pause_reason",
              "monitoring_rules.trigger_schedule_id",
              "monitoring_rules.last_executed_at",
              "monitoring_rules.last_execution_status",
              "monitoring_rules.last_metric_value",
              "monitoring_rules.consecutive_breaches",
              "monitoring_rules.total_executions",
              "monitoring_rules.total_alerts_sent",
              "monitoring_rules.created_by",
              "monitoring_rules.created_at",
              "monitoring_rules.updated_at",
            ])
            .orderBy("monitoring_rules.created_at", "desc")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute()) as Record<string, unknown>[];

          return json({ rules: rules.map(deserializeRule), total, page, pageSize });
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : "Failed to list monitoring rules" },
            { status: 500 }
          );
        }
      }),

      POST: withApiHandler("/api/monitoring/rules", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

          const body = (await request.json()) as {
            name: string;
            description?: string;
            reportDefinitionId?: string;
            dataSourceId: string;
            metricColumn: string;
            thresholdOperator: ThresholdOperator;
            thresholdValue: number;
            thresholdUpperBound?: number;
            escalationThresholdPct?: number;
            cronExpression: string;
            timezone?: string;
            alertChannels: AlertChannel[];
            alertRecipients?: AlertRecipient[];
            webhookUrl?: string;
            notifyOnPass?: boolean;
            notifyOnNoData?: boolean;
            originalNlRequest?: string;
            adkIntentId?: string;
            sql?: string;
          };

          const required = [
            "name",
            "dataSourceId",
            "metricColumn",
            "thresholdOperator",
            "thresholdValue",
            "cronExpression",
            "alertChannels",
          ] as const;
          for (const field of required) {
            if (body[field] === undefined || body[field] === null || body[field] === "") {
              return json({ error: `Missing required field: ${field}` }, { status: 400 });
            }
          }

          const db = getDb();
          const userId = session.user.id;
          const roles = session.user.roles;
          const permissions = session.user.permissions;
          const securityContext = { userId, roles, permissions };
          const rbacSnapshot = await resolveRBACContext(userId, securityContext);

          const id = crypto.randomUUID();
          const now = new Date().toISOString().slice(0, 19).replace("T", " ");

          let reportDefinitionId = body.reportDefinitionId;
          if (!reportDefinitionId && body.sql) {
            const queryId = crypto.randomUUID();
            reportDefinitionId = crypto.randomUUID();
            await (db as any)
              .insertInto("saved_queries")
              .values({
                id: queryId,
                name: `[Monitor] ${body.name}`,
                description: "Auto-generated monitoring query",
                data_source_id: body.dataSourceId,
                sql_content: body.sql,
                is_validated: true,
                created_by: userId,
                created_at: now,
                updated_at: now,
              })
              .execute();

            await (db as any)
              .insertInto("report_definitions")
              .values({
                id: reportDefinitionId,
                name: `[Monitor] ${body.name}`,
                description: body.description ?? null,
                saved_query_id: queryId,
                column_config: JSON.stringify([]),
                pagination_config: JSON.stringify({ pageSize: 10000 }),
                export_formats: JSON.stringify(["csv"]),
                created_by: userId,
                created_at: now,
                updated_at: now,
              })
              .execute();
          }

          if (!reportDefinitionId) {
            return json(
              { error: "Either reportDefinitionId or sql must be provided" },
              { status: 400 }
            );
          }

          await (db as any)
            .insertInto("monitoring_rules")
            .values({
              id,
              name: body.name,
              description: body.description ?? null,
              report_definition_id: reportDefinitionId,
              data_source_id: body.dataSourceId,
              created_by: userId,
              metric_column: body.metricColumn,
              threshold_operator: body.thresholdOperator,
              threshold_value: body.thresholdValue,
              threshold_upper_bound: body.thresholdUpperBound ?? null,
              escalation_threshold_pct: body.escalationThresholdPct ?? 20,
              cron_expression: body.cronExpression,
              timezone: body.timezone ?? "UTC",
              alert_channels: JSON.stringify(body.alertChannels),
              alert_recipients: JSON.stringify(
                body.alertRecipients ?? [{ type: "user", id: userId }]
              ),
              webhook_url: body.webhookUrl ?? null,
              notify_on_pass: body.notifyOnPass ? 1 : 0,
              notify_on_no_data: body.notifyOnNoData !== false ? 1 : 0,
              rbac_snapshot: JSON.stringify(rbacSnapshot),
              rbac_snapshot_version: 1,
              is_active: 1,
              is_paused: 0,
              original_nl_request: body.originalNlRequest ?? null,
              adk_intent_id: body.adkIntentId ?? null,
              consecutive_breaches: 0,
              total_executions: 0,
              total_alerts_sent: 0,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const rule = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown>;

          try {
            const scheduleId = await scheduleMonitoringRule(deserializeRule(rule) as any);
            if (scheduleId) {
              await (db as any)
                .updateTable("monitoring_rules")
                .set({ trigger_schedule_id: scheduleId })
                .where("id", "=", id)
                .execute();
              rule.trigger_schedule_id = scheduleId;
            }
          } catch (scheduleErr) {
            getLogger("jobs").event("jobs.schedule.failed", { target: "monitoring rule", err: scheduleErr });
          }

          await logAudit({
            userId,
            action: AUDIT_ACTIONS.MONITORING.RULE_CREATED,
            resourceType: "monitoring_rule" as any,
            resourceId: id,
            details: { name: body.name, dataSourceId: body.dataSourceId },
          });

          return json({ rule: deserializeRule(rule) }, { status: 201 });
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : "Failed to create monitoring rule" },
            { status: 500 }
          );
        }
      }),
    },
  },
});
