import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { json } from "@/lib/server/response";

/**
 * GET /api/search?q=&limit= — reports, charts, dashboards and saved queries by
 * name or description, in one call.
 *
 * Each kind is searched only when the caller's role grants its `:view`, the
 * same permission the kind's own list endpoint asks for; a kind the caller may
 * not view contributes nothing and is not mentioned. It returns names and ids,
 * never SQL and never data: running or opening a result goes through that
 * result's own route and its own checks.
 */
const KINDS = [
  { kind: "report", table: "report_definitions", resource: "report" },
  { kind: "chart", table: "chart_definitions", resource: "chart" },
  { kind: "dashboard", table: "dashboard_layouts", resource: "dashboard" },
  { kind: "query", table: "saved_queries", resource: "query" },
] as const;

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: withApiHandler("/api/search", async ({ request }) => {
        const { auth } = await import("@/lib/auth/config");
        const session = await auth(request);
        if (!session?.user) {
          return json(
            { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
            { status: 401 }
          );
        }

        const { searchParams } = new URL(request.url);
        const q = (searchParams.get("q") ?? "").trim().slice(0, 200);
        const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "10", 10) || 10, 1), 50);
        if (!q) return json({ success: true, items: [] });

        const { getDb } = await import("@/lib/db/config");
        const db = getDb();
        // `%` and `_` in what somebody typed are text, not wildcards.
        const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

        const items: Array<{ kind: string; id: string; name: string; description: string | null }> = [];
        for (const { kind, table, resource } of KINDS) {
          if (refuseWithoutPermission(session.user, resource, "view")) continue;
          const rows = await db
            .selectFrom(table)
            .select(["id", "name", "description"])
            .where((eb) => eb.or([eb("name", "ilike", pattern), eb("description", "ilike", pattern)]))
            .orderBy("name")
            .limit(limit)
            .execute();
          for (const row of rows) {
            items.push({ kind, id: String(row.id), name: row.name, description: row.description ?? null });
          }
        }

        return json({ success: true, items: items.slice(0, limit * KINDS.length) });
      }),
    },
  },
});
