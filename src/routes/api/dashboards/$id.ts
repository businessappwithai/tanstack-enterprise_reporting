import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
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

export const Route = createFileRoute("/api/dashboards/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/dashboards/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "view");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const db = getDb();
          const dashboard = await db
            .selectFrom("dashboard_layouts")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!dashboard) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }

          return json({ success: true, data: dashboard });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch dashboard");
        }
      }),

      PUT: withApiHandler("/api/dashboards/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "edit");
          if (denied) return denied;

          const { id } = params;
          const body = await request.json();
          // Accept both camelCase (layoutConfig) and snake_case (layout_config) from clients
          const { name, description, layout_config, layoutConfig, is_public } = body;
          const resolvedLayoutConfig = layout_config ?? layoutConfig;

          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("dashboard_layouts")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "dashboard");
          if (notYours) return notYours;
          const existing = await db
            .selectFrom("dashboard_layouts")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }

          await db
            .updateTable("dashboard_layouts")
            .set({
              name: name ?? existing.name,
              description: description !== undefined ? description : existing.description,
              layout_config: resolvedLayoutConfig
                ? JSON.stringify(resolvedLayoutConfig)
                : existing.layout_config,
              is_public: is_public !== undefined ? is_public : existing.is_public,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", id)
            .execute();

          // Non-fatal — audit log failure must not break the save
          logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "dashboard",
            resourceId: id,
          }).catch((err) => getLogger("audit").event("audit.write.failed", { resource: "dashboard", err }));

          const dashboard = await db
            .selectFrom("dashboard_layouts")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();
          return json({ success: true, data: dashboard });
        } catch (error) {
          throw serverFailure(error, "Failed to update dashboard");
        }
      }),

      PATCH: withApiHandler("/api/dashboards/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "edit");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("dashboard_layouts")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "dashboard");
          if (notYours) return notYours;

          /*
           * Visibility is the only thing PATCH changes here. The Share dialog sends
           * { isPublic } to this URL; with no PATCH handler the request fell through to
           * the application's HTML page — a 200 that changed nothing — so a dashboard could
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
            .updateTable("dashboard_layouts")
            .set({ is_public: isPublic, updated_at: new Date().toISOString() })
            .where("id", "=", id)
            .execute();

          await logAudit({
            userId: session.user.id,
            action: "update",
            resourceType: "dashboard",
            resourceId: id,
            details: { is_public: isPublic },
          });

          return json({ success: true, data: { id, is_public: isPublic } });
        } catch (error) {
          throw serverFailure(error, "Failed to update visibility");
        }
      }),

      DELETE: withApiHandler("/api/dashboards/$id", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "dashboard", "delete");
          if (denied) return denied;

          const { id } = params;
          const { getDb } = await import("@/lib/db/config");
          const { logAudit } = await import("@/lib/security/audit");
          const db = getDb();
          const owner = await db
            .selectFrom("dashboard_layouts")
            .select("created_by")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!owner) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Dashboard not found" } },
              { status: 404 }
            );
          }
          const notYours = refuseUnlessOwnerOrAdmin(session.user, owner.created_by, "dashboard");
          if (notYours) return notYours;

          await db.deleteFrom("dashboard_layouts").where("id", "=", id).execute();

          await logAudit({
            userId: session.user.id,
            action: "delete",
            resourceType: "dashboard",
            resourceId: id,
          });

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete dashboard");
        }
      }),
    },
  },
});
