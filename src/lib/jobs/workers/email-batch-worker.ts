import fs from "node:fs/promises";
import { sql } from "kysely";
import path from "node:path";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { getDb } from "@/lib/db/config";
import { getConnection } from "@/lib/db/connection-manager";
import { refuseJobQuery } from "@/lib/permissions/actor";
import { sendEmail } from "@/lib/email/email-service";
import { logAudit } from "@/lib/security/audit";
import { JOB_OUTPUT_DIR } from "../output-dir";
import type { EmailBatchJobData, JobResult } from "../types";
import { getLogger } from "@/lib/logging/logger";


export async function processEmailBatchJob(data: EmailBatchJobData): Promise<JobResult> {
  const startTime = Date.now();
  const {
    queryId,
    emailTemplateId,
    recipientQueryId,
    recipientEmailColumn,
    userId,
    format = "csv",
    reportName = "Report",
    parameters: _parameters,
  } = data;

  let attachmentPath: string | null = null;
  let emailsSent = 0;

  try {
    // === STAGE 1: Generate Report Attachment ===

    const db = getDb();

    // Get the report query
    const reportQuery = await db
      .selectFrom("saved_queries")
      .where("id", "=", queryId)
      .selectAll()
      .executeTakeFirst();

    if (!reportQuery) {
      throw new Error(`Report query not found: ${queryId}`);
    }

    // Get data source for report query
    const reportDataSource = await db
      .selectFrom("data_sources")
      .where("id", "=", reportQuery.data_source_id)
      .selectAll()
      .executeTakeFirst();

    if (!reportDataSource) {
      throw new Error("Report data source not found");
    }

    // Both queries run as the job's owner, with the access they hold now.
    const reportRefusal = await refuseJobQuery(
      userId,
      reportQuery.sql_content,
      reportQuery.data_source_id
    );
    if (reportRefusal) throw new Error(reportRefusal);

    // Execute report query
    const reportConnection = await getConnection(reportDataSource);
    const reportResult = await sql
      .raw<Record<string, unknown>>(reportQuery.sql_content)
      .execute(reportConnection);

    let reportRows: Record<string, unknown>[] = [];
    if (Array.isArray(reportResult)) {
      reportRows = reportResult;
    } else if (reportResult.rows) {
      reportRows = reportResult.rows;
    }


    // Ensure output directory exists
    await fs.mkdir(JOB_OUTPUT_DIR, { recursive: true });

    // Generate export file
    const timestamp = Date.now();
    const filename = `${reportName.replace(/\s+/g, "_")}_${timestamp}.${format}`;
    attachmentPath = path.join(JOB_OUTPUT_DIR, filename);

    switch (format) {
      case "csv":
        await exportToCSV(reportRows, attachmentPath);
        break;
      case "xlsx":
        await exportToXLSX(reportRows, reportName, attachmentPath);
        break;
      case "pdf":
        await exportToPDF(reportRows, reportName, attachmentPath);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }


    // === STAGE 2: Fetch Email Template ===

    const template = await db
      .selectFrom("email_templates")
      .where("id", "=", emailTemplateId)
      .selectAll()
      .executeTakeFirst();

    if (!template) {
      throw new Error(`Email template not found: ${emailTemplateId}`);
    }

    // Parse column mappings
    const columnMappings = template.column_mappings ? JSON.parse(template.column_mappings) : {};

    // === STAGE 3: Fetch Recipients ===

    const recipientQuery = await db
      .selectFrom("saved_queries")
      .where("id", "=", recipientQueryId)
      .selectAll()
      .executeTakeFirst();

    if (!recipientQuery) {
      throw new Error(`Recipient query not found: ${recipientQueryId}`);
    }

    // Get data source for recipient query
    const recipientDataSource = await db
      .selectFrom("data_sources")
      .where("id", "=", recipientQuery.data_source_id)
      .selectAll()
      .executeTakeFirst();

    if (!recipientDataSource) {
      throw new Error("Recipient data source not found");
    }

    const recipientRefusal = await refuseJobQuery(
      userId,
      recipientQuery.sql_content,
      recipientQuery.data_source_id
    );
    if (recipientRefusal) throw new Error(recipientRefusal);

    // Execute recipient query
    const recipientConnection = await getConnection(recipientDataSource);
    const recipientResult = await sql
      .raw<Record<string, unknown>>(recipientQuery.sql_content)
      .execute(recipientConnection);

    let recipientRows: Record<string, unknown>[] = [];
    if (Array.isArray(recipientResult)) {
      recipientRows = recipientResult;
    } else if (recipientResult.rows) {
      recipientRows = recipientResult.rows;
    }

    if (recipientRows.length === 0) {
      throw new Error("No recipients found from recipient query");
    }


    // Validate email column exists
    if (!recipientRows[0][recipientEmailColumn]) {
      throw new Error(
        `Email column '${recipientEmailColumn}' not found in recipient query results`
      );
    }

    // === STAGE 4: Send Batch Emails ===
    getLogger("jobs").event("jobs.email_batch.started", { total: recipientRows.length });

    const failedRecipients: Array<{ email: string; error: string }> = [];

    for (let i = 0; i < recipientRows.length; i++) {
      const recipient = recipientRows[i];
      const recipientEmail = String(recipient[recipientEmailColumn]);


      try {
        // Apply column mappings to get variables for template
        const variables: Record<string, unknown> = {};
        Object.entries(columnMappings).forEach(([placeholder, columnName]) => {
          variables[placeholder] = recipient[columnName as string];
        });

        // Add common variables
        variables._recipientNumber = i + 1;
        variables._totalRecipients = recipientRows.length;
        variables._reportName = reportName;
        variables._generatedAt = new Date().toISOString();

        // Send email with attachment
        const result = await sendEmail(
          recipientEmail,
          {
            subject: template.subject,
            htmlBody: template.html_body ?? template.body,
          },
          variables,
          null, // No query results for batch emails (use column mappings instead)
          [
            {
              filename: path.basename(attachmentPath),
              path: attachmentPath,
            },
          ]
        );

        if (result.success) {
          emailsSent++;
        } else {
          failedRecipients.push({ email: recipientEmail, error: result.error || "Unknown error" });
          getLogger("jobs").event("jobs.email_batch.recipient_failed", { position: i + 1, reason: result.error || "Unknown error" });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        failedRecipients.push({ email: recipientEmail, error: errorMsg });
        getLogger("jobs").event("jobs.email_batch.recipient_failed", { position: i + 1, reason: errorMsg });
      }
    }

    // Log audit
    await logAudit({
      userId,
      action: "email_batch",
      resourceType: "job",
      resourceId: queryId,
      details: {
        emailsSent,
        failedRecipients: failedRecipients.length,
        attachmentPath,
        reportRows: reportRows.length,
        recipientCount: recipientRows.length,
      },
    });

    getLogger("jobs").event("jobs.email_batch.completed", {
      total: recipientRows.length,
      sent: emailsSent,
      failed: failedRecipients.length,
    });

    return {
      success: true,
      outputLocation: attachmentPath,
      rowCount: reportRows.length,
      duration: Date.now() - startTime,
      emailsSent,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await logAudit({
      userId,
      action: "email_batch",
      resourceType: "job",
      resourceId: queryId,
      details: { error: errorMessage, emailsSent },
    });

    return {
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
      emailsSent,
    };
  }
}

async function exportToCSV(rows: Record<string, unknown>[], outputPath: string): Promise<void> {
  if (rows.length === 0) {
    await fs.writeFile(outputPath, "");
    return;
  }

  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const value = row[h];
          if (value === null || value === undefined) return "";
          const str = String(value);
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(",")
    ),
  ];

  await fs.writeFile(outputPath, csvLines.join("\n"));
}

async function exportToXLSX(
  rows: Record<string, unknown>[],
  reportName: string,
  outputPath: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(reportName);

  if (rows.length === 0) {
    await workbook.xlsx.writeFile(outputPath);
    return;
  }

  const headers = Object.keys(rows[0]);

  worksheet.addRow(headers);

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE0E0E0" },
  };

  rows.forEach((row) => {
    worksheet.addRow(headers.map((h) => row[h]));
  });

  worksheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const cellLength = cell.value ? String(cell.value).length : 0;
      if (cellLength > maxLength) {
        maxLength = cellLength;
      }
    });
    column.width = Math.min(maxLength + 2, 50);
  });

  await workbook.xlsx.writeFile(outputPath);
}

async function exportToPDF(
  rows: Record<string, unknown>[],
  reportName: string,
  outputPath: string
): Promise<void> {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(reportName, 14, 20);

  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);

  if (rows.length === 0) {
    doc.text("No data available", 14, 40);
    doc.save(outputPath);
    return;
  }

  const headers = Object.keys(rows[0]);
  const tableData = rows.map((row) =>
    headers.map((h) => {
      const value = row[h];
      if (value === null || value === undefined) return "";
      return String(value);
    })
  );

  autoTable(doc, {
    head: [headers],
    body: tableData,
    startY: 35,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [66, 66, 66] },
  });

  const pdfBuffer = doc.output("arraybuffer");
  await fs.writeFile(outputPath, Buffer.from(pdfBuffer));
}

export const sendEmailBatch = processEmailBatchJob;
