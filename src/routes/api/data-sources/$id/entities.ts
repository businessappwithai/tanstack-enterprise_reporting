import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { EntityService } from "@/lib/metadata/entity-service";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/data-sources/$id/entities")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id/entities", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
          }

          // Verify the data source exists
          const db = getDb();
          const dataSource = await db
            .selectFrom("data_sources" as any)
            .select(["id"] as any)
            .where("id" as any, "=", params.id)
            .where("is_deleted" as any, "=", false)
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              { success: false, error: { message: "Data source not found" } },
              { status: 404 }
            );
          }

          const url = new URL(request.url);
          const includeFields = url.searchParams.get("include_fields") === "true";
          const activeOnly = url.searchParams.get("active_only") !== "false";

          if (includeFields) {
            // Fetch entities with fields using EntityService.getById per entity
            const { entities, total } = await EntityService.list({
              data_source_id: params.id,
              include_hidden: !activeOnly,
              limit: 500,
            });

            const entitiesWithFields = await Promise.all(
              entities.map((e) => EntityService.getById(e.id))
            );

            return json({
              success: true,
              data: {
                entities: entitiesWithFields.filter(Boolean),
                total,
              },
            });
          }

          const { entities, total } = await EntityService.list({
            data_source_id: params.id,
            include_hidden: !activeOnly,
            limit: 500,
          });

          return json({ success: true, data: { entities, total } });
        } catch (error) {
          throw serverFailure(error, "Internal server error");
        }
      }),
    },
  },
});
