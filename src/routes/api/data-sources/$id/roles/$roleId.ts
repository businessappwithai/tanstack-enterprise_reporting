import { createFileRoute } from "@tanstack/react-router";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { recordFailure } from "@/lib/logging/request-context";
import { deleteDsRole, getDsRole } from "@/lib/permissions/ds-rbac";
import { apiFailure, auditDsRbac, authorizeDsAdmin } from "@/lib/permissions/ds-rbac-api";
import { json } from "@/lib/server/response";

export const Route = createFileRoute("/api/data-sources/$id/roles/$roleId")({
  server: {
    handlers: {
      DELETE: withApiHandler("/api/data-sources/$id/roles/$roleId", async ({ request, params }: { request: Request; params: { id: string; roleId: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          // The role must belong to *this* data source: the id alone would let a caller
          // delete another data source's role through a data source they may manage.
          const role = await getDsRole(params.roleId);
          if (!role || role.data_source_id !== params.id) {
            return apiFailure("NOT_FOUND", "Role not found", 404);
          }

          await deleteDsRole(role.id);
          await auditDsRbac(who.user, "delete", params.id, { role: role.name, roleId: role.id });
          return json({ success: true });
        } catch (error) {
          recordFailure(error, "[ds-rbac] delete role failed:");
          return apiFailure("SERVER_ERROR", "Failed to delete the role", 500);
        }
      }),
    },
  },
});
