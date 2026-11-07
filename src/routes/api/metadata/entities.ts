import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { EntityService } from "@/lib/metadata/entity-service";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/metadata/entities")({
  server: {
    handlers: {
      GET: withApiHandler("/api/metadata/entities", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "view");
          if (denied) return denied;

          const url = new URL(request.url);
          const dataSourceId = url.searchParams.get("data_source_id");
          const includeHidden = url.searchParams.get("include_hidden") === "true";
          const isActive = url.searchParams.get("is_active") !== "false";

          if (!dataSourceId) {
            return json({ error: { message: "data_source_id is required" } }, { status: 400 });
          }

          const result = await EntityService.list({
            data_source_id: dataSourceId,
            include_hidden: includeHidden,
          });

          return json({
            data: {
              entities: result.entities,
              total: result.total,
            },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch entities");
        }
      }),
    },
  },
});
