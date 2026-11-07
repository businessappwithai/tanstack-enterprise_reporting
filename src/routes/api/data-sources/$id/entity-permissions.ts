import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { z } from "zod";
import { getDb } from "@/lib/db/config";
import {
  deleteDsEntityPermission,
  getDsEntityPermissions,
  getDsRole,
  upsertDsEntityPermission,
} from "@/lib/permissions/ds-rbac";
import { apiFailure, auditDsRbac, authorizeDsAdmin } from "@/lib/permissions/ds-rbac-api";
import { json } from "@/lib/server/response";

const permissionSchema = z.object({
  ds_role_id: z.string().trim().min(1, "ds_role_id is required").max(255),
  entity_name: z.string().trim().min(1, "entity_name is required").max(255),
  entity_type: z.enum(["table", "view"]),
  permission_level: z.enum(["select", "insert", "update", "delete", "all"]),
});

export const Route = createFileRoute("/api/data-sources/$id/entity-permissions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id/entity-permissions", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;
          const roleId = new URL(request.url).searchParams.get("ds_role_id") || undefined;
          return json({ success: true, data: await getDsEntityPermissions(params.id, roleId) });
        } catch (error) {
          recordFailure(error, "[ds-rbac] list permissions failed:");
          return apiFailure("SERVER_ERROR", "Failed to load permissions", 500);
        }
      }),

      POST: withApiHandler("/api/data-sources/$id/entity-permissions", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return apiFailure("INVALID_JSON", "Request body must be valid JSON", 400);
          }
          const parsed = permissionSchema.safeParse(body);
          if (!parsed.success) {
            return apiFailure("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input", 422);
          }
          const input = parsed.data;

          const role = await getDsRole(input.ds_role_id);
          if (!role || role.data_source_id !== params.id) {
            return apiFailure("NOT_FOUND", "Role not found for this data source", 404);
          }

          const permission = await upsertDsEntityPermission(
            params.id,
            role.id,
            input.entity_name,
            input.entity_type,
            input.permission_level,
            undefined,
            undefined,
            undefined,
            who.user.id
          );
          await auditDsRbac(who.user, "update", params.id, {
            role: role.name,
            entity: input.entity_name,
            level: input.permission_level,
          });
          return json({ success: true, data: permission }, { status: 201 });
        } catch (error) {
          recordFailure(error, "[ds-rbac] set permission failed:");
          return apiFailure("SERVER_ERROR", "Failed to save the permission", 500);
        }
      }),

      DELETE: withApiHandler("/api/data-sources/$id/entity-permissions", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          const permissionId = new URL(request.url).searchParams.get("permission_id");
          if (!permissionId) return apiFailure("INVALID_INPUT", "permission_id is required", 422);

          // Scoped to this data source, so a permission id from another one is a 404.
          const existing = await getDb()
            .selectFrom("ds_entity_permissions")
            .select(["id", "entity_name"])
            .where("id", "=", permissionId)
            .where("data_source_id", "=", params.id)
            .executeTakeFirst();
          if (!existing) return apiFailure("NOT_FOUND", "Permission not found", 404);

          await deleteDsEntityPermission(existing.id);
          await auditDsRbac(who.user, "update", params.id, {
            removedPermissionOn: existing.entity_name,
          });
          return json({ success: true });
        } catch (error) {
          recordFailure(error, "[ds-rbac] delete permission failed:");
          return apiFailure("SERVER_ERROR", "Failed to remove the permission", 500);
        }
      }),
    },
  },
});
