import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
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

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export const Route = createFileRoute("/api/email-templates/")({
  server: {
    handlers: {
      // Paginated and searched at the database, per the rule in CLAUDE.md.
      GET: withApiHandler("/api/email-templates/", async ({ request }: { request: Request }) => {
        try {
          const who = await authorizeTemplates(request, "view");
          if (who instanceof Response) return who;

          const params = new URL(request.url).searchParams;
          const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0);
          const pageSize = Math.min(
            MAX_PAGE_SIZE,
            Math.max(1, Number.parseInt(params.get("pageSize") ?? "", 10) || DEFAULT_PAGE_SIZE)
          );
          const search = params.get("search")?.trim();

          const db = getDb();
          let base = db.selectFrom("email_templates");
          if (search) base = base.where("name", "ilike", `%${search.replace(/[%_\\]/g, "\\$&")}%`);

          const [{ total }] = await base
            .select(sql<number>`count(*)::int`.as("total"))
            .execute();
          const rows = await base
            .selectAll()
            .orderBy("updated_at", "desc")
            .orderBy("id", "desc")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute();

          return json({
            success: true,
            data: {
              items: (rows as unknown as EmailTemplateRow[]).map(toEmailTemplate),
              meta: { total, page, pageSize },
            },
          });
        } catch (error) {
          recordFailure(error, "[email-templates] list failed:");
          return templateFailure("SERVER_ERROR", "Failed to load email templates", 500);
        }
      }),

      POST: withApiHandler("/api/email-templates/", async ({ request }: { request: Request }) => {
        try {
          const who = await authorizeTemplates(request, "edit");
          if (who instanceof Response) return who;

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

          const now = new Date().toISOString();
          const id = crypto.randomUUID();
          await db
            .insertInto("email_templates")
            .values({
              id,
              name: input.name,
              subject: input.subject,
              body: input.htmlBody,
              html_body: input.htmlBody,
              column_mappings: JSON.stringify(input.columnMappings),
              query_id: input.queryId ?? null,
              created_by: who.user.id,
              created_at: now,
              updated_at: now,
            })
            .execute();

          await logAudit({
            userId: who.user.id,
            action: "create",
            resourceType: "setting",
            resourceId: id,
            details: { area: "email-template", name: input.name },
          }).catch((err) => getLogger("audit").event("audit.write.failed", { resource: "email_template", err }));

          const row = await db
            .selectFrom("email_templates")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
          return json(
            { success: true, data: toEmailTemplate(row as unknown as EmailTemplateRow) },
            { status: 201 }
          );
        } catch (error) {
          recordFailure(error, "[email-templates] create failed:");
          return templateFailure("SERVER_ERROR", "Failed to create the template", 500);
        }
      }),
    },
  },
});
