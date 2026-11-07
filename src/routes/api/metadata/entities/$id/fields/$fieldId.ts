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

export const Route = createFileRoute("/api/metadata/entities/$id/fields/$fieldId")({
  server: {
    handlers: {
      PUT: withApiHandler("/api/metadata/entities/$id/fields/$fieldId", async ({ request, params }: { request: Request; params: { id: string; fieldId: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          const denied = refuseWithoutPermission(session.user, "metadata_entity", "edit");
          if (denied) return denied;

          const body = await request.json();
          const {
            description,
            is_display_field,
            is_searchable,
            display_order,
            relationship_ui_type,
          } = body;

          // metadata tables not in main schema
          const db = getDb() as any;
          const now = new Date().toISOString();

          const updated = await db
            .updateTable("metadata_entity_field")
            .set({
              ...(description !== undefined && { description }),
              ...(is_display_field !== undefined && { is_display_field }),
              ...(is_searchable !== undefined && { is_searchable }),
              ...(display_order !== undefined && { display_order }),
              ...(relationship_ui_type !== undefined && { relationship_ui_type }),
              updated_at: now,
            })
            .where("id", "=", params.fieldId)
            .where("entity_header_id", "=", params.id)
            .returningAll()
            .executeTakeFirst();

          if (!updated) {
            return json({ error: { message: "Field not found" } }, { status: 404 });
          }

          return json({ success: true, data: updated });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
