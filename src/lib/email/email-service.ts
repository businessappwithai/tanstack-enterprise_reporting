import nodemailer from "nodemailer";
import { getLogger } from "@/lib/logging/logger";

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  htmlBody: string;
  queryId?: string;
  columnMappings: Record<string, string>; // placeholder -> column name
  created_at: string;
  updated_at: string;
}

export interface EmailAttachment {
  filename: string;
  path?: string;
  content?: Buffer | string;
}

// Built-in templates
const builtInTemplates = {
  jobCompleted: {
    subject: "Job Completed: {{jobName}}",
    htmlBody: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4f46e5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .job-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #4f46e5; }
          .status { padding: 10px 20px; border-radius: 4px; display: inline-block; margin: 10px 0; }
          .status.success { background: #d1fae5; color: #065f46; }
          .status.failed { background: #fee2e2; color: #991b1b; }
          .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          .button { display: inline-block; padding: 12px 24px; background: #4f46e5; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
          .data-table { width: 100%; border-collapse: collapse; margin: 20px 0; background: white; }
          .data-table th { background: #4f46e5; color: white; padding: 12px; text-align: left; }
          .data-table td { padding: 10px; border-bottom: 1px solid #e5e7eb; }
          .data-table tr:last-child td { border-bottom: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📊 Job Completed</h1>
          </div>
          <div class="content">
            <p>Hello {{userName}},</p>
            <p>Your scheduled job <strong>{{jobName}}</strong> has completed.</p>

            <div class="job-details">
              <h3>Job Details</h3>
              <p><strong>Status:</strong> <span class="status {{statusClass}}">{{status}}</span></p>
              <p><strong>Scheduled:</strong> {{schedule}}</p>
              <p><strong>Completed At:</strong> {{completedAt}}</p>
              <p><strong>Duration:</strong> {{duration}}ms</p>
              {{#if rowCount}}
              <p><strong>Rows Exported:</strong> {{rowCount}}</p>
              {{/if}}
            </div>

            {{#if resultUrl}}
            <div style="text-align: center;">
              <a href="{{resultUrl}}" class="button">📥 Download Results</a>
            </div>
            {{/if}}

            {{#if queryResults}}
            <div class="job-details">
              <h3>Query Results</h3>
              {{queryResults}}
            </div>
            {{/if}}

            {{#if errorMessage}}
            <div class="job-details" style="border-left-color: #ef4444;">
              <h3 style="color: #dc2626;">❌ Error</h3>
              <p>{{errorMessage}}</p>
            </div>
            {{/if}}
          </div>
          <div class="footer">
            <p>This is an automated message from Enterprise Reporting System</p>
          </div>
        </div>
      </body>
      </html>
    `,
  },

  jobFailed: {
    subject: "❌ Job Failed: {{jobName}}",
    htmlBody: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc2626; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .error-box { background: #fee2e2; padding: 20px; border-radius: 8px; border-left: 4px solid #dc2626; margin: 20px 0; }
          .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Job Failed</h1>
          </div>
          <div class="content">
            <p>Hello {{userName}},</p>
            <p>Your scheduled job <strong>{{jobName}}</strong> has failed.</p>

            <div class="error-box">
              <h3>Error Details</h3>
              <p><strong>Time:</strong> {{failedAt}}</p>
              <p><strong>Error:</strong></p>
              <pre style="background: white; padding: 10px; border-radius: 4px; overflow-x: auto;">{{errorMessage}}</pre>
            </div>

            <p>Please check the job configuration and try again.</p>
          </div>
          <div class="footer">
            <p>This is an automated message from Enterprise Reporting System</p>
          </div>
        </div>
      </body>
      </html>
    `,
  },
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Simple template engine with query result support.
 *
 * `{{name}}` is replaced with a value; `{{#if name}}…{{/if}}` keeps its content when the
 * value is truthy; `{{queryResults}}` becomes a table of the first ten rows.
 *
 * Values are HTML-escaped when rendering an HTML body (`html: true`, the default) and left
 * alone for a plain-text subject. They used to be inserted raw, so a value held in a
 * database row — a recipient's name, a product description — became live markup in every
 * email sent from it: a link, a form, an image that phones home. And they are replaced with
 * a function, not a replacement string, because String.replace reads `$&`, `$1` and `$$`
 * inside a replacement string, so a value containing a dollar sign could rewrite itself.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, any>,
  queryResults?: Record<string, unknown>[] | null,
  options: { html?: boolean } = {}
): string {
  const html = options.html ?? true;
  const out = (value: unknown) => (html ? escapeHtml(value) : String(value ?? ""));
  let result = template;

  // Conditionals first, so a placeholder inside a dropped block is never rendered.
  result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (_, varName, content) => {
    return variables[varName] ? content : "";
  });

  // Handle query results placeholder
  if (queryResults && queryResults.length > 0 && result.includes("{{queryResults}}")) {
    const columns = Object.keys(queryResults[0]);
    let tableHtml = '<table class="data-table">\n<thead>\n<tr>\n';
    tableHtml += columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("\n");
    tableHtml += "\n</tr>\n</thead>\n<tbody>\n";

    // Limit to 10 rows for email
    for (const row of queryResults.slice(0, 10)) {
      tableHtml += "<tr>\n";
      tableHtml += columns.map((col) => `<td>${escapeHtml(row[col])}</td>`).join("\n");
      tableHtml += "\n</tr>\n";
    }

    if (queryResults.length > 10) {
      tableHtml += `<tr><td colspan="${columns.length}" style="text-align: center; color: #6b7280;">... and ${queryResults.length - 10} more rows</td></tr>`;
    }

    tableHtml += "\n</tbody>\n</table>";
    result = result.replace("{{queryResults}}", () => tableHtml);
  }

  // {{name}} placeholders: explicit variables win; otherwise a column of the first result row.
  const firstRow = queryResults && queryResults.length > 0 ? queryResults[0] : undefined;
  result = result.replace(/{{(\w+)}}/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) return out(variables[name]);
    if (firstRow && Object.prototype.hasOwnProperty.call(firstRow, name)) return out(firstRow[name]);
    return whole;
  });

  return result;
}

// Get transporter with connection pooling
function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
  });
}

// Send email with custom template
export async function sendEmail(
  to: string | string[],
  template: {
    subject: string;
    htmlBody: string;
  },
  variables: Record<string, any>,
  queryResults?: Record<string, unknown>[] | null,
  attachments?: EmailAttachment[]
): Promise<{ success: boolean; error?: string; messageId?: string }> {
  try {
    const transporter = getTransporter();
    const from = process.env.EMAIL_FROM_NAME
      ? `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_FROM}>`
      : process.env.EMAIL_FROM || "noreply@example.com";

    // Render template with variables and query results
    const html = renderTemplate(template.htmlBody, variables, queryResults);
    const subject = renderTemplate(template.subject, variables, null, { html: false });

    const mailOptions = {
      from,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
      attachments: attachments?.map((att) => ({
        filename: att.filename,
        path: att.path,
        content: att.content,
      })),
    };

    const info = await transporter.sendMail(mailOptions);

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    getLogger("email").note("error", "Error sending email:", { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Send email using built-in template name
export async function sendEmailWithTemplate(
  to: string | string[],
  templateName: keyof typeof builtInTemplates,
  variables: Record<string, any>,
  queryResults?: Record<string, unknown>[] | null,
  attachments?: EmailAttachment[]
): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const template = builtInTemplates[templateName];

  return await sendEmail(
    to,
    {
      subject: template.subject,
      htmlBody: template.htmlBody,
    },
    variables,
    queryResults,
    attachments
  );
}

// Test email configuration
export async function sendTestEmail(to: string): Promise<{ success: boolean; error?: string }> {
  const variables = {
    smtpHost: process.env.SMTP_HOST || "localhost",
    smtpPort: process.env.SMTP_PORT || 587,
    fromEmail: process.env.EMAIL_FROM || "noreply@example.com",
    sentAt: new Date().toISOString(),
  };

  return await sendEmailWithTemplate(to, "jobCompleted", variables);
}

// Verify email configuration
export async function verifyEmailConfig(): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}
