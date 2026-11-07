/**
 * What every route under /api/data-sources/:id/{roles,user-roles,entity-permissions}
 * asks before it does anything: who is calling, may they manage this data source, and
 * does it exist.
 *
 * These endpoints decide who may read which tables, so they take the same permission as
 * editing the data source itself (`data_source:edit`) — whoever can re-point the
 * connection could grant themselves anything here anyway, so a stricter rule would only
 * be a different door to the same room. A signed-in account with no data-source rights
 * (the Analyst, Viewer and NLQueryUser roles) is refused.
 */

import { auth } from "@/lib/auth/config";
import type { SessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { refuseWithoutDataSourcePermission } from "@/lib/permissions/data-source-guard";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";
import { getLogger } from "@/lib/logging/logger";

export function apiFailure(code: string, message: string, status: number, details?: unknown) {
  return json({ success: false, error: { code, message, details } }, { status });
}

export async function authorizeDsAdmin(
  request: Request,
  dataSourceId: string
): Promise<{ user: SessionUser } | Response> {
  const session = await auth(request);
  if (!session?.user) return apiFailure("UNAUTHORIZED", "Not authenticated", 401);

  const refusal = refuseWithoutDataSourcePermission(session.user, "edit");
  if (refusal) return refusal;

  const exists = await getDb()
    .selectFrom("data_sources")
    .select("id")
    .where("id", "=", dataSourceId)
    .where("is_deleted", "=", false)
    .executeTakeFirst();
  if (!exists) return apiFailure("NOT_FOUND", "Data source not found", 404);

  return { user: session.user };
}

/** Audit a change to who may read what. A failed audit write is logged, not fatal. */
export async function auditDsRbac(
  user: SessionUser,
  action: "create" | "update" | "delete",
  dataSourceId: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    await logAudit({
      userId: user.id,
      action,
      resourceType: "data_source",
      resourceId: dataSourceId,
      details: { area: "ds-rbac", ...details },
    });
  } catch (err) {
    getLogger("auth").note("error", "[ds-rbac] Failed to audit-log a permission change:", { err: err });
  }
}
