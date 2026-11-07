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

export const Route = createFileRoute("/api/metadata/entities/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/metadata/entities/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "view");
          if (denied) return denied;

          const entity = await EntityService.getById(params.id);
          if (!entity) {
            return json({ error: { message: "Entity not found" } }, { status: 404 });
          }

          return json({ success: true, data: entity });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      PUT: withApiHandler("/api/metadata/entities/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "edit");
          if (denied) return denied;

          const body = await request.json();
          const { description, is_active, is_hidden } = body;

          const updated = await EntityService.update(
            params.id,
            { description, is_active, is_hidden },
            session.user.id
          );

          if (!updated) {
            return json({ error: { message: "Entity not found" } }, { status: 404 });
          }

          return json({ success: true, data: updated });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),

      DELETE: withApiHandler("/api/metadata/entities/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "delete");
          if (denied) return denied;

          const deleted = await EntityService.delete(params.id, session.user.id);
          if (!deleted) {
            return json({ error: { message: "Entity not found" } }, { status: 404 });
          }

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
