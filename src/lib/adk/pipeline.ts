/**
 * ADK Pipeline Orchestrator
 *
 * Coordinates the 4-stage ADK pipeline:
 *   Stage 1 – Intent Classification    (classifyIntent)
 *   Stage 2 – RBAC Context Resolution  (resolveRBACContext)
 *   Stage 3 – Schema Introspection     (executeSchemaIntrospect)
 *   Stage 4 – SQL Generation           (executeSqlGenerate)
 *   Stage 5 – Supervisor Validation    (runSupervisorAgent via Mastra)
 *   Stage 6 – Artifact Persistence     (executeRulePersist)
 *
 * Guardrails:
 *  - Confidence < 0.5 → returns clarification request (no DB writes)
 *  - User lacks execute permission on data source → throws 403
 *  - SQL generation failure → marks intent as 'partial', propagates error
 *  - Every stage error updates the stored intent for full traceability
 */

import { z } from "zod";
import { getDb } from "@/lib/db/config";
import { canAccessResource, getSecurityContext } from "@/lib/auth/rbac";
import { resolveRBACContext } from "@/lib/monitoring/rbac-workflow-context";
import { classifyIntent } from "./intent-classifier";
import { executeSchemaIntrospect } from "./tools/schema-introspect-tool";
import { executeSqlGenerate } from "./tools/sql-generate-tool";
import { executeRulePersist } from "./tools/rule-persist-tool";
import { logAudit } from "@/lib/security/audit";
import { AUDIT_ACTIONS } from "@/types/actions";
import type { ADKIntent, ADKPipelineResult, ADKPreview, ADKStoredIntent } from "@/types/adk";
import type { SecurityContext } from "@/lib/auth/rbac";
import { getLogger } from "@/lib/logging/logger";

// ─── ADK Intent Store (inline — avoids circular import with monitoring-repository) ─

function isoNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

async function storeADKIntent(data: Omit<ADKStoredIntent, "id" | "created_at">): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = isoNow();
  await (db as any)
    .insertInto("adk_intents")
    .values({
      id,
      user_id: data.user_id,
      session_id: data.session_id ?? null,
      raw_nl_request: data.raw_nl_request,
      request_source: data.request_source ?? "text",
      intent_type: data.intent_type,
      confidence: data.confidence ?? null,
      adk_intent_json: JSON.stringify(data.adk_intent_json),
      pipeline_status: data.pipeline_status ?? "pending",
      report_definition_id: data.report_definition_id ?? null,
      monitoring_rule_id: data.monitoring_rule_id ?? null,
      error_message: data.error_message ?? null,
      classification_ms: data.classification_ms ?? null,
      total_pipeline_ms: data.total_pipeline_ms ?? null,
      created_at: now,
    })
    .execute();
  return id;
}

async function updateADKIntent(
  id: string,
  updates: {
    pipeline_status?: string;
    report_definition_id?: string;
    monitoring_rule_id?: string;
    error_message?: string;
    total_pipeline_ms?: number;
  }
): Promise<void> {
  const db = getDb();
  await (db as any).updateTable("adk_intents").set(updates).where("id", "=", id).execute();
}

// ─── Supervisor validation via Mastra HTTP ─────────────────────────────────────

const SupervisorResultSchema = z.object({
  success: z.boolean(),
  intent: z.object({
    intent_type: z.string(),
    confidence: z.number(),
    metric: z.string().optional(),
    data_hint: z.string().optional(),
    schedule_natural: z.string().optional(),
    schedule_cron: z.string().optional(),
    threshold_operator: z.string().optional(),
    threshold_value: z.number().optional(),
    alert_channels: z.array(z.string()).optional(),
  }),
  reportDefinition: z.object({
    sql: z.string(),
    metric_column: z.string(),
    explanation: z.string(),
    confidence: z.number(),
    warnings: z.array(z.string()),
  }),
  monitoringRule: z.object({
    name: z.string(),
    description: z.string(),
    threshold_operator: z.string(),
    threshold_value: z.number(),
    escalation_threshold_pct: z.number(),
    alert_channels: z.array(z.string()),
    notify_on_pass: z.boolean(),
    notify_on_no_data: z.boolean(),
  }),
  schedule: z.object({
    cron_expression: z.string(),
    timezone: z.string(),
    description: z.string(),
  }),
  clarificationNeeded: z.boolean().optional(),
  clarificationPrompt: z.string().optional(),
  error: z.string().optional(),
});

async function callMastraSupervisor(
  nlRequest: string,
  userId: string,
  dataSourceId: string,
  dataSourceType: string,
  schemaText: string,
  allowedTableNames: string[],
  rbacSnapshot: unknown,
  sessionId?: string
): Promise<z.infer<typeof SupervisorResultSchema>> {
  const mastraUrl = process.env.MASTRA_URL ?? "http://localhost:4111";
  const response = await fetch(`${mastraUrl}/api/build-monitoring-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nlRequest,
      userId,
      dataSourceId,
      dataSourceType,
      schemaText,
      allowedTableNames,
      rbacSnapshot,
      sessionId,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    throw new Error(`Mastra supervisor failed: HTTP ${response.status}`);
  }

  const raw = await response.json();
  return SupervisorResultSchema.parse(raw);
}

// ─── Pipeline Entry Point ──────────────────────────────────────────────────────

export async function runADKPipeline(
  nlRequest: string,
  userId: string,
  dataSourceId: string,
  sessionId?: string,
  options: { dryRun?: boolean } = {}
): Promise<ADKPipelineResult> {
  const pipelineStart = Date.now();
  let intentId: string | undefined;

  try {
    // ── Stage 1: Intent Classification ────────────────────────────────────────
    const classifyStart = Date.now();
    const { intent, classificationMs } = await classifyIntent(nlRequest, userId, dataSourceId);
    const stage1Ms = Date.now() - classifyStart;

    await logAudit({
      userId,
      action: AUDIT_ACTIONS.ADK.INTENT_CLASSIFIED,
      resourceType: "adk_intent",
      details: { intentType: intent.intentType, confidence: intent.confidence },
    });

    // Store intent for traceability (even if pipeline fails after this)
    intentId = await storeADKIntent({
      user_id: userId,
      session_id: sessionId,
      raw_nl_request: nlRequest,
      request_source: "text",
      intent_type: intent.intentType,
      confidence: intent.confidence,
      adk_intent_json: intent,
      pipeline_status: "pending",
      classification_ms: classificationMs,
    });

    // Guardrail: low confidence or ambiguous → request clarification
    if (intent.confidence < 0.5 || intent.intentType === "ambiguous") {
      await updateADKIntent(intentId, {
        pipeline_status: "partial",
        error_message: "Low confidence — clarification required",
      });

      return {
        success: false,
        intentId,
        adkIntent: intent,
        clarificationNeeded: true,
        clarificationPrompt:
          "I need a bit more detail. Please specify: what metric to track, the threshold condition (e.g. 'if revenue drops below $50,000'), and when to run (e.g. 'every Monday').",
      };
    }

    // ── Stage 2: RBAC Permission Check ────────────────────────────────────────
    // Build a minimal security context from the user record
    const db = getDb();
    const userRoles = await db
      .selectFrom("user_roles")
      .innerJoin("roles", "roles.id", "user_roles.role_id")
      .where("user_roles.user_id", "=", userId)
      .select(["roles.name", "roles.permissions"])
      .execute();

    const roles = userRoles.map((r) => r.name);
    const permissions = userRoles.flatMap((r) => {
      try {
        return JSON.parse(r.permissions as string) as string[];
      } catch {
        return [] as string[];
      }
    });

    const securityContext: SecurityContext = { userId, roles, permissions };
    const isAdmin = roles.some((r) => r.toLowerCase() === "admin");

    if (!isAdmin) {
      const hasAccess = await canAccessResource(
        securityContext,
        "data_source",
        dataSourceId,
        "execute"
      );
      if (!hasAccess) {
        await updateADKIntent(intentId, {
          pipeline_status: "failed",
          error_message: "RBAC: User does not have execute permission on the selected data source",
        });
        return {
          success: false,
          intentId,
          adkIntent: intent,
          error: "You do not have execute permission on the selected data source.",
        };
      }
    }

    // Resolve and snapshot RBAC context
    const rbacSnapshot = await resolveRBACContext(userId, securityContext);

    // ── Stage 3: RBAC-Filtered Schema Introspection ───────────────────────────
    const schema = await executeSchemaIntrospect({ dataSourceId, userId });

    await logAudit({
      userId,
      action: AUDIT_ACTIONS.ADK.SCHEMA_INTROSPECTED,
      resourceType: "data_source",
      resourceId: dataSourceId,
      details: { tableCount: schema.tables.length },
    });

    // ── Stage 4–6: Mastra Supervisor Orchestration ────────────────────────────
    // The supervisor calls specialist agents for SQL gen, rule build, and schedule.
    // Limit schema to first 4000 chars to keep LLM prompt manageable.
    const MAX_SCHEMA_CHARS = 4000;
    const truncatedSchema =
      schema.schemaText.length > MAX_SCHEMA_CHARS
        ? `${schema.schemaText.slice(0, MAX_SCHEMA_CHARS)}\n... (schema truncated for LLM context)`
        : schema.schemaText;

    let supervisorResult: z.infer<typeof SupervisorResultSchema>;
    try {
      supervisorResult = await callMastraSupervisor(
        nlRequest,
        userId,
        dataSourceId,
        schema.dataSourceType,
        truncatedSchema,
        schema.allowedTableNames,
        rbacSnapshot,
        sessionId
      );
    } catch (supervisorErr) {
      // Fallback: use the direct SQL generation tool if supervisor is unreachable
      getLogger("nlquery").event("nlquery.pipeline.degraded", { what: "Mastra supervisor unreachable, falling back to direct SQL generation", err: supervisorErr });
      const sqlResult = await executeSqlGenerate({
        nlQuestion: nlRequest,
        schemaText: truncatedSchema,
        dataSourceType: schema.dataSourceType,
        dataSourceId,
      });

      supervisorResult = {
        success: sqlResult.sql.length > 0,
        intent: {
          intent_type: intent.intentType,
          confidence: intent.confidence,
          metric: intent.metric ?? "value",
          schedule_cron: intent.scheduleCron ?? "0 8 * * 1",
          threshold_operator: intent.thresholdOperator ?? "lt",
          threshold_value: intent.thresholdValue ?? 0,
          alert_channels: intent.alertChannels ?? ["email", "in_app"],
        },
        reportDefinition: {
          sql: sqlResult.sql,
          metric_column: intent.metric ?? "value",
          explanation: sqlResult.explanation,
          confidence: sqlResult.confidence,
          warnings: sqlResult.warnings,
        },
        monitoringRule: {
          name: `Monitor: ${intent.metric ?? "metric"}`,
          description: intent.rawRequest,
          threshold_operator: intent.thresholdOperator ?? "lt",
          threshold_value: intent.thresholdValue ?? 0,
          escalation_threshold_pct: 20,
          alert_channels: (intent.alertChannels ?? ["email", "in_app"]) as (
            | "email"
            | "in_app"
            | "webhook"
          )[],
          notify_on_pass: false,
          notify_on_no_data: true,
        },
        schedule: {
          cron_expression: intent.scheduleCron ?? "0 8 * * 1",
          timezone: "UTC",
          description: intent.scheduleNatural ?? "Every Monday",
        },
      };
    }

    // Guardrail: supervisor returned clarification request
    if (supervisorResult.clarificationNeeded) {
      await updateADKIntent(intentId, {
        pipeline_status: "partial",
        error_message: "Supervisor requested clarification",
      });
      return {
        success: false,
        intentId,
        adkIntent: intent,
        clarificationNeeded: true,
        clarificationPrompt: supervisorResult.clarificationPrompt,
      };
    }

    // Guardrail: supervisor failed to generate valid SQL
    if (!supervisorResult.success || !supervisorResult.reportDefinition.sql) {
      await updateADKIntent(intentId, {
        pipeline_status: "partial",
        error_message: supervisorResult.error ?? "SQL generation failed",
      });
      return {
        success: false,
        intentId,
        adkIntent: intent,
        error: supervisorResult.error ?? "Could not generate valid SQL for the requested metric.",
      };
    }

    await logAudit({
      userId,
      action: AUDIT_ACTIONS.ADK.SQL_GENERATED,
      resourceType: "adk_intent",
      resourceId: intentId,
      details: { metricColumn: supervisorResult.reportDefinition.metric_column },
    });

    // Build preview for dry-run (analysis-only) mode
    const preview: ADKPreview = {
      name: supervisorResult.monitoringRule.name,
      description: supervisorResult.monitoringRule.description,
      sql: supervisorResult.reportDefinition.sql,
      metricColumn: supervisorResult.reportDefinition.metric_column,
      thresholdOperator: supervisorResult.monitoringRule.threshold_operator,
      thresholdValue: supervisorResult.monitoringRule.threshold_value,
      escalationThresholdPct: supervisorResult.monitoringRule.escalation_threshold_pct,
      cronExpression: supervisorResult.schedule.cron_expression,
      timezone: supervisorResult.schedule.timezone,
      scheduleDescription: supervisorResult.schedule.description,
      alertChannels: supervisorResult.monitoringRule.alert_channels,
      notifyOnPass: supervisorResult.monitoringRule.notify_on_pass,
      notifyOnNoData: supervisorResult.monitoringRule.notify_on_no_data,
    };

    if (options.dryRun) {
      await updateADKIntent(intentId, {
        pipeline_status: "partial",
        error_message: "dry-run: awaiting user confirmation",
      });
      return { success: true, intentId, adkIntent: intent, preview };
    }

    // ── Stage 6: Persist Report + Rule + Job ──────────────────────────────────
    const { reportDefinitionId, monitoringRuleId, jobDefinitionId } = await executeRulePersist({
      name: supervisorResult.monitoringRule.name,
      description: supervisorResult.monitoringRule.description,
      sql: supervisorResult.reportDefinition.sql,
      dataSourceId,
      metricColumn: supervisorResult.reportDefinition.metric_column,
      thresholdOperator: supervisorResult.monitoringRule.threshold_operator as any,
      thresholdValue: supervisorResult.monitoringRule.threshold_value,
      escalationThresholdPct: supervisorResult.monitoringRule.escalation_threshold_pct,
      cronExpression: supervisorResult.schedule.cron_expression,
      timezone: supervisorResult.schedule.timezone,
      alertChannels: supervisorResult.monitoringRule.alert_channels as any,
      alertRecipients: [{ type: "user", id: userId }],
      notifyOnPass: supervisorResult.monitoringRule.notify_on_pass,
      notifyOnNoData: supervisorResult.monitoringRule.notify_on_no_data,
      createdBy: userId,
      rbacSnapshot,
      originalNlRequest: nlRequest,
      adkIntentId: intentId,
    });

    // Update the stored intent with the persisted IDs
    await updateADKIntent(intentId, {
      pipeline_status: "success",
      report_definition_id: reportDefinitionId,
      monitoring_rule_id: monitoringRuleId,
      total_pipeline_ms: Date.now() - pipelineStart,
    });

    await logAudit({
      userId,
      action: AUDIT_ACTIONS.ADK.PIPELINE_COMPLETED,
      resourceType: "monitoring_rule",
      resourceId: monitoringRuleId,
      details: { reportDefinitionId, jobDefinitionId, totalMs: Date.now() - pipelineStart },
    });

    return {
      success: true,
      intentId,
      reportDefinitionId,
      monitoringRuleId,
      jobDefinitionId,
      adkIntent: intent,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (intentId) {
      await updateADKIntent(intentId, {
        pipeline_status: "failed",
        error_message: errMsg,
        total_pipeline_ms: Date.now() - pipelineStart,
      }).catch(() => {});
    }

    await logAudit({
      userId,
      action: AUDIT_ACTIONS.ADK.PIPELINE_FAILED,
      resourceType: "adk_intent",
      resourceId: intentId,
      details: { error: errMsg },
    }).catch(() => {});

    return {
      success: false,
      intentId,
      error: errMsg,
    };
  }
}
