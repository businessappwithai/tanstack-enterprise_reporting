import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import {
  refuseUnlessOwnerOrAdmin,
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";

function fail(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status });
}

export const Route = createFileRoute("/api/datasets/$id")({
  server: {
    handlers: {
      DELETE: withApiHandler("/api/datasets/$id", async ({ request, params }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "query", "delete");
          if (denied) return denied;

          const db = getDb();
          const dataset = await db
            .selectFrom("datasets")
            .select(["id", "name", "created_by"])
            .where("id", "=", params.id)
            .executeTakeFirst();
          if (!dataset) return fail(404, "NOT_FOUND", "Dataset not found");

          const notYours = refuseUnlessOwnerOrAdmin(session.user, dataset.created_by, "query");
          if (notYours) return notYours;

          await db.deleteFrom("datasets").where("id", "=", params.id).execute();
          await logAudit({
            userId: session.user.id,
            action: "delete",
            resourceType: "query",
            resourceId: params.id,
            details: { dataset: dataset.name },
          });

          return json({ success: true });
        } catch (error) {
          recordFailure(error, "Error deleting dataset:");
          return fail(500, "SERVER_ERROR", "Failed to delete dataset");
        }
      }),
    },
  },
});
