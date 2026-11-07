import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/metadata/entities/$id/fields")({
  server: {
    handlers: {
      GET: withApiHandler("/api/metadata/entities/$id/fields", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "view");
          if (denied) return denied;

          // metadata tables not in main schema
          const db = getDb() as any;
          const fields = await db
            .selectFrom("metadata_entity_field")
            .selectAll()
            .where("entity_header_id", "=", params.id)
            .orderBy("display_order", "asc")
            .execute();

          return json({ success: true, data: fields });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
