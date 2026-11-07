import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import {
  refuseUnlessOwnerOrAdmin,
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

export const Route = createFileRoute("/api/charts/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/charts/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "view");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();
          const chart = await db
            .selectFrom("chart_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!chart) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }

          return json({ success: true, data: chart });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch chart");
        }
      }),

      PUT: withApiHandler("/api/charts/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "edit");
          if (denied) return denied;

          const { id } = params;
          const body = await request.json();
          const {
            name,
            description,
            chart_type,
            chart_config,
            data_mapping,
            saved_query_id,
            refresh_interval,
          } = body;

          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("chart_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "chart");
          if (notYours) return notYours;
          const existing = await db
            .selectFrom("chart_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }

          await db
            .updateTable("chart_definitions")
            .set({
              name: name ?? existing.name,
              description: description !== undefined ? description : existing.description,
              chart_type: chart_type ?? existing.chart_type,
              chart_config: chart_config ? JSON.stringify(chart_config) : existing.chart_config,
              data_mapping: data_mapping ? JSON.stringify(data_mapping) : existing.data_mapping,
              saved_query_id:
                saved_query_id !== undefined ? saved_query_id : existing.saved_query_id,
              refresh_interval: refresh_interval ?? existing.refresh_interval,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", id)
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "chart",
            resourceId: id,
          });

          const chart = await db
            .selectFrom("chart_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();
          return json({ success: true, data: chart });
        } catch (error) {
          throw serverFailure(error, "Failed to update chart");
        }
      }),

      PATCH: withApiHandler("/api/charts/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "edit");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("chart_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "chart");
          if (notYours) return notYours;

          /*
           * Visibility is the only thing PATCH changes here. The Share dialog sends
           * { isPublic } to this URL; with no PATCH handler the request fell through to
           * the application's HTML page — a 200 that changed nothing — so a chart could
           * not be made public or private from the dialog at all.
           */
          const body = (await request.json().catch(() => null)) as {
            isPublic?: unknown;
            is_public?: unknown;
          } | null;
          const isPublic = body?.isPublic ?? body?.is_public;
          if (typeof isPublic !== "boolean") {
            return json(
              {
                success: false,
                error: { code: "INVALID_INPUT", message: "isPublic must be true or false" },
              },
              { status: 422 }
            );
          }

          await db
            .updateTable("chart_definitions")
            .set({ is_public: isPublic, updated_at: new Date().toISOString() })
            .where("id", "=", id)
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "chart",
            resourceId: id,
            details: { is_public: isPublic },
          });

          return json({ success: true, data: { id, is_public: isPublic } });
        } catch (error) {
          throw serverFailure(error, "Failed to update visibility");
        }
      }),

      DELETE: withApiHandler("/api/charts/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "delete");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("chart_definitions")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Chart not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "chart");
          if (notYours) return notYours;

          await db.deleteFrom("chart_definitions").where("id", "=", id).execute();

          await logAudit({
            userId: session.user.id,
            action: "delete",
            resourceType: "chart",
            resourceId: id,
          });

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete chart");
        }
      }),
    },
  },
});
