import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { z } from "zod";
import { getDb } from "@/lib/db/config";
import {
  assignDsUserRole,
  getDsRole,
  getDsUserRoles,
  removeDsUserRole,
} from "@/lib/permissions/ds-rbac";
import { apiFailure, auditDsRbac, authorizeDsAdmin } from "@/lib/permissions/ds-rbac-api";
import { json } from "@/lib/server/response";

const assignSchema = z.object({
  user_id: z.string().trim().min(1, "user_id is required").max(255),
  ds_role_id: z.string().trim().min(1, "ds_role_id is required").max(255),
});

export const Route = createFileRoute("/api/data-sources/$id/user-roles")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id/user-roles", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;
          return json({ success: true, data: await getDsUserRoles(params.id) });
        } catch (error) {
          recordFailure(error, "[ds-rbac] list assignments failed:");
          return apiFailure("SERVER_ERROR", "Failed to load assignments", 500);
        }
      }),

      POST: withApiHandler("/api/data-sources/$id/user-roles", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return apiFailure("INVALID_JSON", "Request body must be valid JSON", 400);
          }
          const parsed = assignSchema.safeParse(body);
          if (!parsed.success) {
            return apiFailure("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input", 422);
          }
          const { user_id: userId, ds_role_id: roleId } = parsed.data;

          const role = await getDsRole(roleId);
          if (!role || role.data_source_id !== params.id || !role.is_active) {
            return apiFailure("NOT_FOUND", "Role not found for this data source", 404);
          }

          const user = await getDb()
            .selectFrom("users")
            .select(["id", "email"])
            .where("id", "=", userId)
            .where("is_active", "=", true)
            .executeTakeFirst();
          if (!user) return apiFailure("NOT_FOUND", "User not found", 404);

          await assignDsUserRole(params.id, user.id, role.id);
          await auditDsRbac(who.user, "update", params.id, {
            assigned: user.email,
            role: role.name,
          });
          return json({ success: true }, { status: 201 });
        } catch (error) {
          recordFailure(error, "[ds-rbac] assign failed:");
          return apiFailure("SERVER_ERROR", "Failed to assign the user", 500);
        }
      }),

      DELETE: withApiHandler("/api/data-sources/$id/user-roles", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          const url = new URL(request.url);
          const userId = url.searchParams.get("user_id");
          const roleId = url.searchParams.get("ds_role_id");
          if (!userId || !roleId) {
            return apiFailure("INVALID_INPUT", "user_id and ds_role_id are required", 422);
          }

          await removeDsUserRole(params.id, userId, roleId);
          await auditDsRbac(who.user, "update", params.id, { removedUserId: userId, roleId });
          return json({ success: true });
        } catch (error) {
          recordFailure(error, "[ds-rbac] unassign failed:");
          return apiFailure("SERVER_ERROR", "Failed to remove the assignment", 500);
        }
      }),
    },
  },
});
