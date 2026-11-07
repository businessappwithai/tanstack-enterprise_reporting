import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { refuseUnlessOwnerOrAdmin } from "@/lib/permissions/resource-guard";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/report-generation/definitions/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/report-generation/definitions/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        const db = getDb();
        const { id } = params;

        const definition = await (db as any)
          .selectFrom("nl_report_definitions as rd")
          .leftJoin("data_sources as ds", "ds.id", "rd.data_source_id")
          .where("rd.id", "=", id)
          .selectAll("rd")
          .select(["ds.name as data_source_name"])
          .executeTakeFirst();

        if (!definition) return json({ error: "Not found" }, { status: 404 });

        const isAdmin = (session.user as any).roles?.some((r: any) => {
          const n = (r.name || r || "").toLowerCase();
          return n === "admin" || n === "administrator" || n.startsWith("admin");
        });
        if (!isAdmin && definition.created_by !== session.user.id) {
          return json({ error: "Forbidden" }, { status: 403 });
        }

        return json({ definition });
      }),

      PATCH: withApiHandler("/api/report-generation/definitions/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        // Same rule GET applies: the owner or an administrator. PATCH and DELETE asked nothing,
        // so any signed-in account could rewrite or delete anyone's scheduled report.
        const ownerRow = await (getDb() as any)
          .selectFrom("nl_report_definitions")
          .where("id", "=", params.id)
          .select("created_by")
          .executeTakeFirst();
        if (!ownerRow) return json({ error: "Not found" }, { status: 404 });
        const notYours = refuseUnlessOwnerOrAdmin(session.user, ownerRow.created_by, "report");
        if (notYours) return notYours;

        const db = getDb();
        const { id } = params;
        const url = new URL(request.url);
        const action = url.searchParams.get("action");

        if (action === "run") {
          const def = await (db as any)
            .selectFrom("nl_report_definitions")
            .where("id", "=", id)
            .select(["last_run_status", "created_by"])
            .executeTakeFirst();

          if (!def) return json({ error: "Not found" }, { status: 404 });
          if (def.last_run_status === "running") {
            return json({ error: "Report is already running" }, { status: 409 });
          }

          const { executeReportGeneration } = await import(
            "@/lib/report-generation/report-generation-worker"
          );
          const result = await executeReportGeneration({
            reportDefinitionId: id,
            triggeredBy: "manual",
          });

          return json({ result });
        }

        const body = await request.json();
        const updates: Record<string, unknown> = {};

        if (body.scheduleCron !== undefined) updates.schedule_cron = body.scheduleCron;
        if (body.scheduleEnabled !== undefined)
          updates.schedule_enabled = body.scheduleEnabled ? 1 : 0;
        if (body.recipients !== undefined)
          updates.recipient_config = JSON.stringify(body.recipients);
        if (body.outputFormats !== undefined)
          updates.output_formats = JSON.stringify(body.outputFormats);
        if (body.title !== undefined) updates.title = body.title;

        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");
          await (db as any)
            .updateTable("nl_report_definitions")
            .set(updates)
            .where("id", "=", id)
            .execute();
        }

        const updated = await (db as any)
          .selectFrom("nl_report_definitions")
          .where("id", "=", id)
          .selectAll()
          .executeTakeFirst();

        return json({ definition: updated });
      }),

      DELETE: withApiHandler("/api/report-generation/definitions/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        // Same rule GET applies: the owner or an administrator. PATCH and DELETE asked nothing,
        // so any signed-in account could rewrite or delete anyone's scheduled report.
        const ownerRow = await (getDb() as any)
          .selectFrom("nl_report_definitions")
          .where("id", "=", params.id)
          .select("created_by")
          .executeTakeFirst();
        if (!ownerRow) return json({ error: "Not found" }, { status: 404 });
        const notYours = refuseUnlessOwnerOrAdmin(session.user, ownerRow.created_by, "report");
        if (notYours) return notYours;

        const db = getDb();
        const { id } = params;

        await (db as any).deleteFrom("nl_report_definitions").where("id", "=", id).execute();

        return json({ success: true });
      }),
    },
  },
});
