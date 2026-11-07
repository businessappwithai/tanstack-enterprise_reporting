import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { DataSourceService } from "@/lib/services/data-source.service";
import { getDb } from "@/lib/db/config";
import { closeConnection } from "@/lib/db/connection-manager";
import { logAudit } from "@/lib/security/audit";
import { refuseForbiddenTarget } from "@/lib/permissions/data-source-guard";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

function checkPermission(session: any, createdBy: string | null): boolean {
  const userRoles: string[] = session.user.roles || [];
  const isAdmin = userRoles.some((r) => r.toLowerCase().includes("admin"));
  const isOwner = createdBy === session.user.id;
  return isAdmin || isOwner;
}

export const Route = createFileRoute("/api/data-sources/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          // No `includeConfig`: this used to pass `true`, so any signed-in account — including the
          // lowest-privileged one — received every data source's host, user and *password* in
          // plaintext. The edit form never needs the secret ("Leave empty to keep current").
          const dataSource = await DataSourceService.getById(params.id);

          if (!dataSource) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          logAudit({
            userId: session.user.id,
            action: "view",
            resourceType: "data_source",
            resourceId: params.id,
            details: { operation: "getDataSource", name: dataSource.name },
          }).catch((err) => {
            getLogger("audit").event("audit.write.failed", { resource: "data_source", err });
          });

          return json(dataSource);
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      PUT: withApiHandler("/api/data-sources/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const db = getDb();
          const existing = await db
            .selectFrom("data_sources")
            .select(["id", "created_by"])
            .where("id", "=", params.id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!existing) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          if (!checkPermission(session, existing.created_by)) {
            return json({ error: { message: "Forbidden" } }, { status: 403 });
          }

          const body = await request.json();
          if (body.connection_config && !body.connectionConfig) {
            body.connectionConfig = body.connection_config;
          }

          const forbiddenTarget = await refuseForbiddenTarget(body.connectionConfig);
          if (forbiddenTarget) return forbiddenTarget;

          await DataSourceService.update(params.id, body, session.user.id);
          await closeConnection(params.id);

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      PATCH: withApiHandler("/api/data-sources/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const db = getDb();
          const existing = await db
            .selectFrom("data_sources")
            .select(["id", "created_by"])
            .where("id", "=", params.id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!existing) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          if (!checkPermission(session, existing.created_by)) {
            return json({ error: { message: "Forbidden" } }, { status: 403 });
          }

          const body = await request.json();

          const forbiddenTarget = await refuseForbiddenTarget(
            body.connectionConfig ?? body.connection_config
          );
          if (forbiddenTarget) return forbiddenTarget;

          await DataSourceService.update(params.id, body, session.user.id);

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      DELETE: withApiHandler("/api/data-sources/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const db = getDb();
          const existing = await db
            .selectFrom("data_sources")
            .select(["id", "created_by"])
            .where("id", "=", params.id)
            .where("is_deleted", "=", false)
            .executeTakeFirst();

          if (!existing) {
            return json({ error: { message: "Data source not found" } }, { status: 404 });
          }

          if (!checkPermission(session, existing.created_by)) {
            return json({ error: { message: "Forbidden" } }, { status: 403 });
          }

          await DataSourceService.softDelete(params.id, session.user.id);

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
