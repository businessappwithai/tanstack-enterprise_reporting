import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { z } from "zod";
import { createDsRole, getDsRoles } from "@/lib/permissions/ds-rbac";
import { apiFailure, auditDsRbac, authorizeDsAdmin } from "@/lib/permissions/ds-rbac-api";
import { json } from "@/lib/server/response";

const createRoleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
});

export const Route = createFileRoute("/api/data-sources/$id/roles")({
  server: {
    handlers: {
      GET: withApiHandler("/api/data-sources/$id/roles", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;
          return json({ success: true, data: await getDsRoles(params.id) });
        } catch (error) {
          recordFailure(error, "[ds-rbac] list roles failed:");
          return apiFailure("SERVER_ERROR", "Failed to load roles", 500);
        }
      }),

      POST: withApiHandler("/api/data-sources/$id/roles", async ({ request, params }: { request: Request; params: { id: string } }) => {
        try {
          const who = await authorizeDsAdmin(request, params.id);
          if (who instanceof Response) return who;

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return apiFailure("INVALID_JSON", "Request body must be valid JSON", 400);
          }
          const parsed = createRoleSchema.safeParse(body);
          if (!parsed.success) {
            return apiFailure("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input", 422);
          }

          const existing = await getDsRoles(params.id);
          if (existing.some((r) => r.name.toLowerCase() === parsed.data.name.toLowerCase())) {
            return apiFailure("DUPLICATE", `A role named "${parsed.data.name}" already exists`, 409);
          }

          const role = await createDsRole(
            params.id,
            parsed.data.name,
            parsed.data.description,
            who.user.id
          );
          await auditDsRbac(who.user, "create", params.id, { role: role.name, roleId: role.id });
          return json({ success: true, data: role }, { status: 201 });
        } catch (error) {
          recordFailure(error, "[ds-rbac] create role failed:");
          return apiFailure("SERVER_ERROR", "Failed to create the role", 500);
        }
      }),
    },
  },
});
