import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";

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

export const Route = createFileRoute("/api/monitoring/rules/$id/executions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/monitoring/rules/$id/executions", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

          const { id } = params;
          const url = new URL(request.url);
          const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
          const pageSize = Math.min(
            100,
            Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10))
          );

          const db = getDb();
          const isAdmin = session.user.roles.some((r: string) => r.toLowerCase().includes("admin"));

          const rule = (await (db as any)
            .selectFrom("monitoring_rules")
            .where("id", "=", id)
            .select(["id", "created_by"])
            .executeTakeFirst()) as { id: string; created_by: string } | undefined;

          if (!rule) return json({ error: "Not found" }, { status: 404 });
          if (!isAdmin && rule.created_by !== session.user.id)
            return json({ error: "Forbidden" }, { status: 403 });

          const totalRow = (await (db as any)
            .selectFrom("monitoring_executions")
            .where("monitoring_rule_id", "=", id)
            .select((db as any).fn.count("id").as("count"))
            .executeTakeFirst()) as { count: number } | undefined;

          const total = Number(totalRow?.count ?? 0);

          const executions = (await (db as any)
            .selectFrom("monitoring_executions")
            .where("monitoring_rule_id", "=", id)
            .selectAll()
            .orderBy("executed_at", "desc")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute()) as Record<string, unknown>[];

          const deserialized = executions.map((e) => ({
            ...e,
            alert_channels_used: parseJsonColumn<string[]>(e.alert_channels_used, []),
            alert_recipients_sent: parseJsonColumn<string[]>(e.alert_recipients_sent, []),
            alert_dispatched: Boolean(e.alert_dispatched),
            metric_value: e.metric_value != null ? Number(e.metric_value) : null,
            previous_metric_value:
              e.previous_metric_value != null ? Number(e.previous_metric_value) : null,
            delta_pct: e.delta_pct != null ? Number(e.delta_pct) : null,
          }));

          return json({ executions: deserialized, total, page, pageSize });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
        }
      }),
    },
  },
});
