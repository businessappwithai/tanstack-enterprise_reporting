/**
 * Report Generation Worker
 *
 * 10-phase pipeline:
 *   1.  Load report definition
 *   2.  RBAC re-validation (drift detection + column-level enforcement)
 *   3.  SQL execution (with row limit + query timeout)
 *   4.  Chart image rendering (ECharts SSR → SVG → sharp → PNG)
 *   5.  Excel artifact build (ExcelJS + chart PNG embedding)
 *   6.  PDF artifact build (jsPDF + autotable + chart PNG on page 1)
 *   7.  CSV artifact build
 *   8.  Persist artifact records
 *   9.  In-app notification
 *  10.  Email dispatch with attachments
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { sql } from "kysely";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { sendEmail } from "@/lib/email/email-service";
import { createNotification } from "@/lib/notifications";
import { logAudit } from "@/lib/security/audit";
import { resolveRBACContext, detectRBACDrift } from "@/lib/monitoring/rbac-workflow-context";
import { renderChartPng } from "./chart-image";
import type { NLReportDefinition, OutputFormat, ReportGenerationResult } from "./types";
import { getLogger } from "@/lib/logging/logger";

const OUTPUT_DIR = process.env.JOB_OUTPUT_PATH || "./job-outputs";
const REPORT_ROW_LIMIT = parseInt(process.env.REPORT_ROW_LIMIT || "10000", 10);
const REPORT_QUERY_TIMEOUT_MS = parseInt(process.env.REPORT_QUERY_TIMEOUT_MS || "30000", 10);
const MAX_EMAIL_ATTACHMENT_BYTES = parseInt(
  process.env.REPORT_EMAIL_MAX_ATTACHMENT_BYTES || "10485760",
  10
);

function isoNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ─── Phase 1: Load Report Definition ────────────────────────────

async function loadReportDefinition(reportDefinitionId: string): Promise<NLReportDefinition> {
  const db = getDb();
  const row = await (db as any)
    .selectFrom("nl_report_definitions")
    .where("id", "=", reportDefinitionId)
    .selectAll()
    .executeTakeFirst();

  if (!row) throw new Error(`Report definition not found: ${reportDefinitionId}`);

  return {
    ...row,
    metric_columns: JSON.parse(row.metric_columns || "[]"),
    dimension_columns: JSON.parse(row.dimension_columns || "[]"),
    filter_config: row.filter_config ? JSON.parse(row.filter_config) : null,
    output_formats: JSON.parse(row.output_formats || '["csv"]'),
    recipient_config: JSON.parse(row.recipient_config || "[]"),
    schedule_enabled: !!row.schedule_enabled,
    schedule_timezone: row.schedule_timezone || "UTC",
    rbac_snapshot: JSON.parse(row.rbac_snapshot || "{}"),
    rbac_snapshot_version: row.rbac_snapshot_version ?? 1,
  } as NLReportDefinition;
}

// ─── Phase 2: RBAC Re-Validation (drift + column-level) ────────

async function validateRBACForReport(
  definition: NLReportDefinition
): Promise<{ granted: boolean; reason?: string }> {
  const db = getDb();
  const userId = definition.created_by;

  const user = await (db as any)
    .selectFrom("users")
    .where("id", "=", userId)
    .select(["id", "is_active"])
    .executeTakeFirst();

  if (!user || !user.is_active) {
    return { granted: false, reason: "User account is inactive" };
  }

  const userRoles = await (db as any)
    .selectFrom("user_roles")
    .innerJoin("roles", "roles.id", "user_roles.role_id")
    .where("user_roles.user_id", "=", userId)
    .select(["roles.id as id", "roles.name as name"])
    .execute();

  const isAdmin = userRoles.some((r: any) => {
    const n = (r.name || "").toLowerCase();
    return n === "admin" || n === "administrator" || n.startsWith("admin");
  });

  if (isAdmin) return { granted: true };

  const securityContext = {
    userId,
    roles: userRoles.map((r: any) => r.name as string),
    permissions: [] as string[],
  };

  // Drift detection: compare stored snapshot against current permissions
  const snapshot = definition.rbac_snapshot;
  if (snapshot && snapshot.userId) {
    const driftResult = await detectRBACDrift(snapshot, userId, securityContext);
    if (!driftResult.canProceed) {
      return {
        granted: false,
        reason: `RBAC drift detected: ${driftResult.details}`,
      };
    }
  }

  // Column-level enforcement: parse SQL column references and validate
  const columnCheck = validateSQLColumnsAgainstRBAC(
    definition.generated_sql,
    definition.data_source_id,
    snapshot
  );
  if (!columnCheck.allowed) {
    return { granted: false, reason: columnCheck.reason };
  }

  return { granted: true };
}

/**
 * Parse referenced columns from the generated SQL and check each against
 * the RBAC snapshot's allowedColumns map.
 *
 * Empty allowedColumns array for a table = full access (all columns pass).
 * Populated array = only those columns are permitted.
 */
function validateSQLColumnsAgainstRBAC(
  sql: string,
  dataSourceId: string,
  snapshot: NLReportDefinition["rbac_snapshot"]
): { allowed: boolean; reason?: string } {
  if (!snapshot?.accessibleDataSources?.length) {
    return { allowed: true };
  }

  const dsSnapshot = snapshot.accessibleDataSources.find((ds) => ds.id === dataSourceId);
  if (!dsSnapshot) {
    return { allowed: false, reason: `Data source ${dataSourceId} not in RBAC snapshot` };
  }

  const normalizedSql = sql.replace(/`/g, "").replace(/"/g, "");
  const sqlUpper = normalizedSql.toUpperCase();

  for (const [table, allowedCols] of Object.entries(dsSnapshot.allowedColumns)) {
    if (allowedCols.length === 0) continue;

    const tableUpper = table.toUpperCase();
    if (!sqlUpper.includes(tableUpper)) continue;

    const allowedSet = new Set(allowedCols.map((c) => c.toUpperCase()));

    // Match table.column references
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tableColRegex = new RegExp(`\\b${escaped}\\s*\\.\\s*(\\w+)`, "gi");
    let match: RegExpExecArray | null = tableColRegex.exec(normalizedSql);
    while (match !== null) {
      const col = match[1].toUpperCase();
      if (col === "*") {
        return {
          allowed: false,
          reason: `SELECT * from table '${table}' is not allowed — column restrictions are in effect. Allowed columns: [${allowedCols.join(", ")}]`,
        };
      }
      if (!allowedSet.has(col)) {
        return {
          allowed: false,
          reason: `Column '${match[1]}' in table '${table}' is not permitted by your RBAC profile. Allowed columns: [${allowedCols.join(", ")}]`,
        };
      }
      match = tableColRegex.exec(normalizedSql);
    }
  }

  return { allowed: true };
}

// ─── Phase 3: SQL Execution ─────────────────────────────────────

async function executeReportSQL(
  dataSourceId: string,
  generatedSQL: string
): Promise<{ rows: Record<string, unknown>[]; columns: string[]; executionMs: number }> {
  const db = getDb();
  const ds = await (db as any)
    .selectFrom("data_sources")
    .where("id", "=", dataSourceId)
    .selectAll()
    .executeTakeFirst();

  if (!ds) throw new Error(`Data source not found: ${dataSourceId}`);

  const connection = await getConnection(ds);

  const cleanSQL = generatedSQL.replace(/;\s*$/, "");
  const limitedSQL = `SELECT * FROM (${cleanSQL}) AS __rpt__ LIMIT ${REPORT_ROW_LIMIT + 1}`;

  const start = Date.now();
  const result = await Promise.race([
    sql.raw(limitedSQL).execute(connection),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Query timeout after ${REPORT_QUERY_TIMEOUT_MS}ms`)),
        REPORT_QUERY_TIMEOUT_MS
      )
    ),
  ]);

  const executionMs = Date.now() - start;
  const rawRows = Array.isArray((result as any).rows)
    ? (result as any).rows
    : Array.isArray(result)
      ? result
      : [];
  const rows = rawRows.length > REPORT_ROW_LIMIT ? rawRows.slice(0, REPORT_ROW_LIMIT) : rawRows;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return { rows, columns, executionMs };
}

// ─── Phase 4: Chart Rendering — see ./chart-image.ts ────────────

// ─── Phase 5: Excel Build ───────────────────────────────────────

async function buildExcelArtifact(
  rows: Record<string, unknown>[],
  columns: string[],
  title: string,
  chartPng: Buffer | null
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Enterprise Reporting Platform";
  wb.created = new Date();

  if (chartPng) {
    const chartSheet = wb.addWorksheet("Chart");
    const imageId = wb.addImage({ buffer: chartPng as any, extension: "png" });
    chartSheet.addImage(imageId, "A1:L28");
    chartSheet.getCell("A30").value = title;
    chartSheet.getCell("A30").font = { bold: true, size: 14 };
    chartSheet.getCell("A31").value =
      `Generated: ${new Date().toLocaleDateString()} — ${rows.length.toLocaleString()} rows`;
  }

  const dataSheet = wb.addWorksheet("Data");
  dataSheet.columns = columns.map((c) => ({
    header: c,
    key: c,
    width: Math.max(12, Math.min(30, c.length + 4)),
  }));

  for (const row of rows) {
    dataSheet.addRow(row);
  }

  const headerRow = dataSheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F3864" },
  };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ─── Phase 6: PDF Build ─────────────────────────────────────────

function buildPdfArtifact(
  rows: Record<string, unknown>[],
  columns: string[],
  title: string,
  chartPng: Buffer | null
): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  doc.setFontSize(18);
  doc.text(title, 14, 20);
  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date().toLocaleDateString()} — ${rows.length.toLocaleString()} rows`,
    14,
    28
  );

  if (chartPng) {
    const chartBase64 = chartPng.toString("base64");
    doc.addImage(`data:image/png;base64,${chartBase64}`, "PNG", 14, 38, 267, 133);
  } else {
    doc.setFontSize(11);
    doc.setTextColor(120);
    doc.text("Chart not available for this report.", 14, 50);
    doc.setTextColor(0);
  }

  doc.addPage();
  autoTable(doc, {
    head: [columns],
    body: rows.map((r) => columns.map((c) => String(r[c] ?? ""))),
    startY: 20,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [31, 56, 100] },
    alternateRowStyles: { fillColor: [240, 244, 250] },
    margin: { top: 15 },
  });

  return Buffer.from(doc.output("arraybuffer"));
}

// ─── Phase 7: CSV Build ─────────────────────────────────────────

function buildCsvArtifact(rows: Record<string, unknown>[], columns: string[]): Buffer {
  const escapeCsv = (val: unknown): string => {
    const str = String(val ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.map(escapeCsv).join(",");
  const body = rows.map((r) => columns.map((c) => escapeCsv(r[c])).join(","));
  return Buffer.from([header, ...body].join("\n"), "utf-8");
}

// ─── Phase 8: Persist Artifact Records ──────────────────────────

async function persistArtifacts(
  reportDefinitionId: string,
  executionId: string,
  createdBy: string,
  triggeredBy: "manual" | "scheduled",
  generatedSQL: string,
  artifacts: { format: OutputFormat; buffer: Buffer }[],
  rowCount: number,
  chartType: string,
  executionMs: number
): Promise<{ format: OutputFormat; filePath: string; fileSizeBytes: number }[]> {
  const db = getDb();
  const outputDir = path.join(OUTPUT_DIR, "reports", reportDefinitionId, executionId);
  await fs.mkdir(outputDir, { recursive: true });

  const results: { format: OutputFormat; filePath: string; fileSizeBytes: number }[] = [];

  for (const artifact of artifacts) {
    const ext = artifact.format === "excel" ? "xlsx" : artifact.format;
    const filePath = path.join(outputDir, `report.${ext}`);
    await fs.writeFile(filePath, artifact.buffer);

    const id = crypto.randomUUID();
    const now = isoNow();

    await (db as any)
      .insertInto("generated_report_artifacts")
      .values({
        id,
        report_definition_id: reportDefinitionId,
        execution_id: executionId,
        created_by: createdBy,
        format: artifact.format,
        file_path: filePath,
        file_size_bytes: artifact.buffer.length,
        row_count: rowCount,
        chart_type: chartType,
        execution_ms: executionMs,
        status: "complete",
        triggered_by: triggeredBy,
        sql_executed: generatedSQL,
        created_at: now,
      })
      .execute();

    results.push({ format: artifact.format, filePath, fileSizeBytes: artifact.buffer.length });
  }

  return results;
}

// ─── Phase 9: In-App Notification ───────────────────────────────

async function notifyReportComplete(
  userId: string,
  reportTitle: string,
  executionId: string,
  status: "success" | "error",
  errorMessage?: string
): Promise<void> {
  await createNotification({
    userId,
    type: status,
    title: status === "success" ? `Report Ready: ${reportTitle}` : `Report Failed: ${reportTitle}`,
    message:
      status === "success"
        ? `Your report "${reportTitle}" has been generated and is ready to download.`
        : `Report "${reportTitle}" failed: ${errorMessage ?? "Unknown error"}`,
    metadata: { executionId, reportTitle },
  });
}

// ─── Phase 10: Email Dispatch ───────────────────────────────────

async function dispatchReportEmail(
  definition: NLReportDefinition,
  artifacts: { format: OutputFormat; buffer: Buffer }[],
  executionId: string
): Promise<void> {
  if (definition.recipient_config.length === 0) return;

  const db = getDb();
  const recipients: string[] = [];

  for (const entry of definition.recipient_config) {
    if (entry.type === "email") {
      recipients.push(entry.value);
    } else if (entry.type === "userId") {
      const user = await (db as any)
        .selectFrom("users")
        .where("id", "=", entry.value)
        .select(["email"])
        .executeTakeFirst();
      if (user?.email) recipients.push(user.email);
    }
  }

  if (recipients.length === 0) return;

  const totalSize = artifacts.reduce((acc, a) => acc + a.buffer.length, 0);
  const useAttachments = totalSize <= MAX_EMAIL_ATTACHMENT_BYTES;

  const slug = definition.title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  const attachments = useAttachments
    ? artifacts.map((a) => ({
        filename: `${slug}.${a.format === "excel" ? "xlsx" : a.format}`,
        content: a.buffer,
      }))
    : [];

  const bodyMessage = useAttachments
    ? `Your report "${definition.title}" is attached in ${artifacts.map((a) => a.format.toUpperCase()).join(", ")} format.`
    : `Your report "${definition.title}" is ready. The files are too large to attach — please download them from the application.`;

  await sendEmail(
    recipients,
    {
      subject: `Report: ${definition.title}`,
      htmlBody: `
        <h2>{{reportTitle}}</h2>
        <p>{{bodyMessage}}</p>
        <p><small>Execution ID: {{executionId}}</small></p>
      `,
    },
    { reportTitle: definition.title, bodyMessage, executionId },
    null,
    attachments
  );
}

// ─── Main Entry Point ───────────────────────────────────────────

export async function executeReportGeneration(params: {
  reportDefinitionId: string;
  triggeredBy: "manual" | "scheduled";
}): Promise<ReportGenerationResult> {
  const startTime = Date.now();
  const executionId = crypto.randomUUID();
  const db = getDb();

  let definition: NLReportDefinition | null = null;

  try {
    definition = await loadReportDefinition(params.reportDefinitionId);

    await (db as any)
      .updateTable("nl_report_definitions")
      .set({ last_run_status: "running", last_run_at: isoNow() })
      .where("id", "=", params.reportDefinitionId)
      .execute();

    const rbac = await validateRBACForReport(definition);
    if (!rbac.granted) {
      await (db as any)
        .updateTable("nl_report_definitions")
        .set({ last_run_status: "permission_revoked" })
        .where("id", "=", params.reportDefinitionId)
        .execute();

      await notifyReportComplete(
        definition.created_by,
        definition.title,
        executionId,
        "error",
        rbac.reason
      );

      return {
        status: "PERMISSION_REVOKED",
        executionId,
        artifacts: [],
        rowCount: 0,
        executionMs: Date.now() - startTime,
        errorMessage: rbac.reason,
      };
    }

    const {
      rows,
      columns,
      executionMs: sqlMs,
    } = await executeReportSQL(definition.data_source_id, definition.generated_sql);

    if (rows.length === 0) {
      await (db as any)
        .updateTable("nl_report_definitions")
        .set({ last_run_status: "no_data" })
        .where("id", "=", params.reportDefinitionId)
        .execute();

      await notifyReportComplete(
        definition.created_by,
        definition.title,
        executionId,
        "error",
        "Query returned no data"
      );
      return {
        status: "NO_DATA",
        executionId,
        artifacts: [],
        rowCount: 0,
        executionMs: Date.now() - startTime,
      };
    }

    const chartPng = await renderChartPng(
      rows,
      columns,
      definition.chart_type,
      definition.metric_columns,
      definition.dimension_columns
    );

    const artifactBuffers: { format: OutputFormat; buffer: Buffer }[] = [];
    for (const fmt of definition.output_formats) {
      if (fmt === "excel") {
        artifactBuffers.push({
          format: "excel",
          buffer: await buildExcelArtifact(rows, columns, definition.title, chartPng),
        });
      } else if (fmt === "pdf") {
        artifactBuffers.push({
          format: "pdf",
          buffer: buildPdfArtifact(rows, columns, definition.title, chartPng),
        });
      } else if (fmt === "csv") {
        artifactBuffers.push({ format: "csv", buffer: buildCsvArtifact(rows, columns) });
      }
    }

    const persistedArtifacts = await persistArtifacts(
      params.reportDefinitionId,
      executionId,
      definition.created_by,
      params.triggeredBy,
      definition.generated_sql,
      artifactBuffers,
      rows.length,
      definition.chart_type,
      sqlMs
    );

    await (db as any)
      .updateTable("nl_report_definitions")
      .set({ last_run_status: "complete", last_run_at: isoNow() })
      .where("id", "=", params.reportDefinitionId)
      .execute();

    await notifyReportComplete(definition.created_by, definition.title, executionId, "success");
    await dispatchReportEmail(definition, artifactBuffers, executionId);

    await logAudit({
      userId: definition.created_by,
      action: "report:generated",
      resourceType: "nl_report_definition" as any,
      resourceId: params.reportDefinitionId,
      details: {
        triggeredBy: params.triggeredBy,
        formats: definition.output_formats,
        rowCount: rows.length,
        executionMs: Date.now() - startTime,
        chartRendered: !!chartPng,
      },
    });

    return {
      status: rows.length >= REPORT_ROW_LIMIT ? "ROW_LIMIT_HIT" : "COMPLETE",
      executionId,
      artifacts: persistedArtifacts,
      rowCount: rows.length,
      executionMs: Date.now() - startTime,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    getLogger("report").event("report.worker.failed", { what: "Failed", detail: [errMsg] });

    if (definition) {
      await (db as any)
        .updateTable("nl_report_definitions")
        .set({ last_run_status: "failed" })
        .where("id", "=", params.reportDefinitionId)
        .execute()
        .catch(() => {});

      await notifyReportComplete(
        definition.created_by,
        definition.title,
        executionId,
        "error",
        errMsg
      ).catch(() => {});
    }

    return {
      status: "FAILED",
      executionId,
      artifacts: [],
      rowCount: 0,
      executionMs: Date.now() - startTime,
      errorMessage: errMsg,
    };
  }
}
