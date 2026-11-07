import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { isAdmin } from "@/lib/permissions/permissions";
import { randomUUID } from "node:crypto";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/admin/permissions")({
  server: {
    handlers: {
      GET: withApiHandler("/api/admin/permissions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          const db = getDb();
          const permissions = await db
            .selectFrom("resource_permissions as rp")
            .leftJoin("roles as r", "r.id", "rp.role_id")
            .select([
              "rp.id",
              "rp.resource_type",
              "rp.resource_id",
              "rp.role_id",
              "r.name as role_name",
              "rp.permission_level",
              "rp.created_at",
            ])
            .orderBy("rp.created_at", "desc")
            .execute();

          return json({ success: true, data: permissions });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch permissions");
        }
      }),

      POST: withApiHandler("/api/admin/permissions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          const body = (await request.json()) as {
            resourceType?: string;
            resourceId?: string;
            roleId?: string;
            permissionLevel?: string;
          };

          if (!body.resourceType || !body.resourceId || !body.roleId || !body.permissionLevel) {
            return json(
              {
                success: false,
                error: {
                  message: "resourceType, resourceId, roleId, and permissionLevel are required",
                },
              },
              { status: 400 }
            );
          }

          const db = getDb();
          const id = randomUUID();
          await db
            .insertInto("resource_permissions")
            .values({
              id,
              resource_type: body.resourceType,
              resource_id: body.resourceId,
              role_id: body.roleId,
              permission_level: body.permissionLevel,
              created_at: new Date().toISOString(),
            })
            .execute();

          return json({ success: true, data: { id } });
        } catch (error) {
          throw serverFailure(error, "Failed to create permission");
        }
      }),

      DELETE: withApiHandler("/api/admin/permissions", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const adminCheck = await isAdmin(session.user.id);
          if (!adminCheck) {
            return json(
              { success: false, error: { message: "Insufficient permissions" } },
              { status: 403 }
            );
          }

          const body = (await request.json()) as { id?: string };
          if (!body.id) {
            return json({ success: false, error: { message: "id is required" } }, { status: 400 });
          }

          const db = getDb();
          await db.deleteFrom("resource_permissions").where("id", "=", body.id).execute();

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Failed to delete permission");
        }
      }),
    },
  },
});
