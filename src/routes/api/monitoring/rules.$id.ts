import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import {
  pauseSchedule,
  resumeSchedule,
  unscheduleMonitoringRule,
} from "@/lib/monitoring/monitoring-scheduler";
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
  return {
    ...row,
    alert_channels: parseJsonColumn<AlertChannel[]>(row.alert_channels, []),
    alert_recipients: parseJsonColumn<AlertRecipient[]>(row.alert_recipients, []),
    rbac_snapshot: parseJsonColumn(row.rbac_snapshot, {}),
    notify_on_pass: Boolean(row.notify_on_pass),
    notify_on_no_data: Boolean(row.notify_on_no_data),
    is_active: Boolean(row.is_active),
    is_paused: Boolean(row.is_paused),
    threshold_value: Number(row.threshold_value),
    threshold_upper_bound:
      row.threshold_upper_bound != null ? Number(row.threshold_upper_bound) : undefined,
    escalation_threshold_pct: Number(row.escalation_threshold_pct ?? 20),
  };
}

export const Route = createFileRoute("/api/monitoring/rules/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/monitoring/rules/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });
          const { id } = params;
          const db = getDb();
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));

          const rule = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown> | undefined;

          if (!rule) return json({ error: "Not found" }, { status: 404 });
          if (!isAdmin && rule.created_by !== session.user.id)
            return json({ error: "Forbidden" }, { status: 403 });
          return json({ rule: deserializeRule(rule) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
        }
      }),

      PUT: withApiHandler("/api/monitoring/rules/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });
          const { id } = params;
          const db = getDb();
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));

          const existing = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown> | undefined;
          if (!existing) return json({ error: "Not found" }, { status: 404 });
          if (!isAdmin && existing.created_by !== session.user.id)
            return json({ error: "Forbidden" }, { status: 403 });

          const body = (await request.json()) as {
            name?: string;
            description?: string;
            metricColumn?: string;
            thresholdOperator?: ThresholdOperator;
            thresholdValue?: number;
            thresholdUpperBound?: number;
            escalationThresholdPct?: number;
            alertChannels?: AlertChannel[];
            alertRecipients?: AlertRecipient[];
            webhookUrl?: string;
            notifyOnPass?: boolean;
            notifyOnNoData?: boolean;
          };

          const updates: Record<string, unknown> = {
            updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          };
          if (body.name !== undefined) updates.name = body.name;
          if (body.description !== undefined) updates.description = body.description;
          if (body.metricColumn !== undefined) updates.metric_column = body.metricColumn;
          if (body.thresholdOperator !== undefined)
            updates.threshold_operator = body.thresholdOperator;
          if (body.thresholdValue !== undefined) updates.threshold_value = body.thresholdValue;
          if (body.thresholdUpperBound !== undefined)
            updates.threshold_upper_bound = body.thresholdUpperBound;
          if (body.escalationThresholdPct !== undefined)
            updates.escalation_threshold_pct = body.escalationThresholdPct;
          if (body.alertChannels !== undefined)
            updates.alert_channels = JSON.stringify(body.alertChannels);
          if (body.alertRecipients !== undefined)
            updates.alert_recipients = JSON.stringify(body.alertRecipients);
          if (body.webhookUrl !== undefined) updates.webhook_url = body.webhookUrl;
          if (body.notifyOnPass !== undefined) updates.notify_on_pass = body.notifyOnPass ? 1 : 0;
          if (body.notifyOnNoData !== undefined)
            updates.notify_on_no_data = body.notifyOnNoData ? 1 : 0;

          await (db as any)
            .updateTable("monitoring_rules")
            .set(updates)
            .where("id", "=", id)
            .execute();
          const updated = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown>;

          await logAudit({
            userId: session.user.id,
            action: AUDIT_ACTIONS.MONITORING.RULE_UPDATED,
            resourceType: "monitoring_rule" as any,
            resourceId: id,
            details: { updatedFields: Object.keys(updates) },
          });

          return json({ rule: deserializeRule(updated) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
        }
      }),

      DELETE: withApiHandler("/api/monitoring/rules/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });
          const { id } = params;
          const db = getDb();
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));

          const rule = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown> | undefined;
          if (!rule) return json({ error: "Not found" }, { status: 404 });
          if (!isAdmin && rule.created_by !== session.user.id)
            return json({ error: "Forbidden" }, { status: 403 });

          if (rule.trigger_schedule_id) {
            await unscheduleMonitoringRule(id, rule.trigger_schedule_id as string).catch(() => {});
          }

          await (db as any).deleteFrom("monitoring_rules").where("id", "=", id).execute();

          await logAudit({
            userId: session.user.id,
            action: AUDIT_ACTIONS.MONITORING.RULE_DELETED,
            resourceType: "monitoring_rule" as any,
            resourceId: id,
            details: { name: rule.name },
          });

          return json({ success: true });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
        }
      }),

      PATCH: withApiHandler("/api/monitoring/rules/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });
          const { id } = params;
          const url = new URL(request.url);
          const action = url.searchParams.get("action");
          const db = getDb();
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));

          const rule = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown> | undefined;
          if (!rule) return json({ error: "Not found" }, { status: 404 });
          if (!isAdmin && rule.created_by !== session.user.id)
            return json({ error: "Forbidden" }, { status: 403 });

          if (action === "pause") {
            const body = (await request.json().catch(() => ({}))) as { reason?: string };
            await (db as any)
              .updateTable("monitoring_rules")
              .set({
                is_paused: 1,
                pause_reason: body.reason ?? null,
                updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
              })
              .where("id", "=", id)
              .execute();
            if (rule.trigger_schedule_id) {
              await pauseSchedule(rule.trigger_schedule_id as string).catch(() => {});
            }
            await logAudit({
              userId: session.user.id,
              action: AUDIT_ACTIONS.MONITORING.RULE_PAUSED,
              resourceType: "monitoring_rule" as any,
              resourceId: id,
            });
          } else if (action === "resume") {
            await (db as any)
              .updateTable("monitoring_rules")
              .set({
                is_paused: 0,
                pause_reason: null,
                updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
              })
              .where("id", "=", id)
              .execute();
            if (rule.trigger_schedule_id) {
              await resumeSchedule(rule.trigger_schedule_id as string).catch(() => {});
            }
            await logAudit({
              userId: session.user.id,
              action: AUDIT_ACTIONS.MONITORING.RULE_RESUMED,
              resourceType: "monitoring_rule" as any,
              resourceId: id,
            });
          } else if (action === "run") {
            const { executeMonitoringEvaluation } = await import(
              "@/lib/jobs/workers/monitoring-worker"
            );
            const result = await executeMonitoringEvaluation({
              ruleId: id,
              triggeredBy: "manual",
            });
            await logAudit({
              userId: session.user.id,
              action: AUDIT_ACTIONS.MONITORING.RULE_UPDATED,
              resourceType: "monitoring_rule" as any,
              resourceId: id,
              details: { operation: "manual_run", status: result.status },
            });
            const updated = (await (db as any)
              .selectFrom("monitoring_rules")
              .where("id", "=", id)
              .selectAll()
              .executeTakeFirst()) as Record<string, unknown>;
            return json({ result, rule: deserializeRule(updated) });
          } else {
            return json(
              { error: "Invalid action. Use ?action=pause, ?action=resume, or ?action=run" },
              { status: 400 }
            );
          }

          const updated = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst()) as Record<string, unknown>;
          return json({ rule: deserializeRule(updated) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
        }
      }),
    },
  },
});
