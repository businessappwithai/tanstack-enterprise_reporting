import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { DataSourceService } from "@/lib/services/data-source.service";
import { logAudit } from "@/lib/security/audit";
import {
  refuseForbiddenTarget,
  refuseWithoutDataSourcePermission,
} from "@/lib/permissions/data-source-guard";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/data-sources/")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const url = new URL(request.url);
          const inspectedOnly = url.searchParams.get("inspected") === "true";
          const dataSources = await DataSourceService.list({ inspectedOnly });

          logAudit({
            userId: session.user.id,
            action: "view",
            resourceType: "data_source",
            details: { operation: "listDataSources", count: dataSources.length },
          }).catch((err) => {
            getLogger("audit").event("audit.write.failed", { resource: "data_source", err });
          });

          return json({
            success: true,
            data: {
              items: dataSources,
              meta: { total: dataSources.length },
            },
          });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      POST: withApiHandler("/api/data-sources/", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const refusal = refuseWithoutDataSourcePermission(session.user, "create");
          if (refusal) return refusal;

          const body = await request.json();
          const { name, description, clientType, connectionConfig } = body;

          const forbiddenTarget = await refuseForbiddenTarget(connectionConfig);
          if (forbiddenTarget) return forbiddenTarget;

          const dataSource = await DataSourceService.create({
            name,
            description,
            clientType,
            connectionConfig,
            userId: session.user.id,
          });

          const { connection_config: _cc, ...safeDataSource } = dataSource;

          return json({ success: true, item: safeDataSource }, { status: 201 });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
