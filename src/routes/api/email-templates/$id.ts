import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { getDb } from "@/lib/db/config";
import {
  authorizeTemplates,
  readJsonBody,
  templateFailure,
} from "@/lib/email/template-api";
import {
  type EmailTemplateRow,
  emailTemplateInputSchema,
  toEmailTemplate,
} from "@/lib/email/templates";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";

async function load(id: string): Promise<EmailTemplateRow | undefined> {
  return (await getDb()
    .selectFrom("email_templates")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as unknown as EmailTemplateRow | undefined;
}

export const Route = createFileRoute("/api/email-templates/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/email-templates/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeTemplates(request, "view");
          if (who instanceof Response) return who;
          const row = await load(params.id);
          if (!row) return templateFailure("NOT_FOUND", "Template not found", 404);
          return json({ success: true, data: toEmailTemplate(row) });
        } catch (error) {
          recordFailure(error, "[email-templates] get failed:");
          return templateFailure("SERVER_ERROR", "Failed to load the template", 500);
        }
      }),

      PUT: withApiHandler("/api/email-templates/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeTemplates(request, "edit");
          if (who instanceof Response) return who;
          if (!(await load(params.id))) return templateFailure("NOT_FOUND", "Template not found", 404);

          const body = await readJsonBody(request);
          if (body instanceof Response) return body;
          const parsed = emailTemplateInputSchema.safeParse(body);
          if (!parsed.success) {
            return templateFailure(
              "INVALID_INPUT",
              parsed.error.issues[0]?.message ?? "Invalid template",
              422
            );
          }
          const input = parsed.data;

          const db = getDb();
          if (input.queryId) {
            const query = await db
              .selectFrom("saved_queries")
              .select("id")
              .where("id", "=", input.queryId)
              .executeTakeFirst();
            if (!query) return templateFailure("NOT_FOUND", "The selected query does not exist", 404);
          }

          await db
            .updateTable("email_templates")
            .set({
              name: input.name,
              subject: input.subject,
              body: input.htmlBody,
              html_body: input.htmlBody,
              column_mappings: JSON.stringify(input.columnMappings),
              query_id: input.queryId ?? null,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", params.id)
            .execute();

          await logAudit({
            userId: who.user.id,
            action: "update",
            resourceType: "setting",
            resourceId: params.id,
            details: { area: "email-template", name: input.name },
          }).catch((err) => getLogger("audit").event("audit.write.failed", { resource: "email_template", err }));

          const row = await load(params.id);
          return json({ success: true, data: toEmailTemplate(row as EmailTemplateRow) });
        } catch (error) {
          recordFailure(error, "[email-templates] update failed:");
          return templateFailure("SERVER_ERROR", "Failed to update the template", 500);
        }
      }),

      DELETE: withApiHandler("/api/email-templates/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeTemplates(request, "edit");
          if (who instanceof Response) return who;
          const row = await load(params.id);
          if (!row) return templateFailure("NOT_FOUND", "Template not found", 404);

          await getDb().deleteFrom("email_templates").where("id", "=", params.id).execute();
          await logAudit({
            userId: who.user.id,
            action: "delete",
            resourceType: "setting",
            resourceId: params.id,
            details: { area: "email-template", name: row.name },
          }).catch((err) => getLogger("audit").event("audit.write.failed", { resource: "email_template", err }));
          return json({ success: true });
        } catch (error) {
          recordFailure(error, "[email-templates] delete failed:");
          return templateFailure("SERVER_ERROR", "Failed to delete the template", 500);
        }
      }),
    },
  },
});
