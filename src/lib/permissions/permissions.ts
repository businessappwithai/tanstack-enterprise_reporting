import { getDb } from "@/lib/db/config";
import type { PermissionLevel, ResourceType } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

export interface PermissionCheck {
  resourceType: ResourceType;
  action: "view" | "edit" | "execute" | "admin" | "delete";
  resourceId?: string;
}

/**
 * Get all permissions for a user including role permissions and resource-level permissions
 */
export async function getUserPermissions(userId: string) {
  const db = getDb();

  // Get user's roles via inner join
  const userRoles = await db
    .selectFrom("user_roles as ur")
    .innerJoin("roles as r", "ur.role_id", "r.id")
    .where("ur.user_id", "=", userId)
    .selectAll("r")
    .execute();

  // Parse role permissions
  const rolePermissions: string[] = [];
  for (const role of userRoles) {
    if (role.permissions) {
      try {
        const perms = JSON.parse(role.permissions);
        rolePermissions.push(...perms);
      } catch (e) {
        getLogger("auth").note("error", "Failed to parse permissions for role:", { detail: [role.name, e] });
      }
    }
  }

  // Get resource-level permissions for these roles
  const roleIds = userRoles.map((r) => r.id);
  const resourcePermissions =
    roleIds.length > 0
      ? await db
          .selectFrom("resource_permissions")
          .selectAll()
          .where("role_id", "in", roleIds)
          .execute()
      : [];

  return {
    userId,
    roles: userRoles,
    rolePermissions,
    resourcePermissions,
  };
}

/**
 * Check if user has admin role (full access)
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const db = getDb();

  const roles = await db
    .selectFrom("user_roles as ur")
    .innerJoin("roles as r", "ur.role_id", "r.id")
    .where("ur.user_id", "=", userId)
    .select(["r.name", "r.permissions"])
    .execute();

  return roles.some((r) => {
    const name = r.name?.toLowerCase();
    if (name === "admin" || name === "administrator") return true;
    try {
      const perms: string[] = JSON.parse(r.permissions || "[]");
      return perms.includes("*") || perms.includes("admin:*");
    } catch {
      return false;
    }
  });
}

/**
 * Check if user has a specific permission.
 * Pass `roles` when available so the Admin role bypasses all checks.
 */
export function hasPermission(
  permissions: string[],
  resourceType: ResourceType,
  action: string,
  roles: string[] = []
): boolean {
  // Admin role — unconditional full access
  if (roles.some((r) => r.toLowerCase() === "admin")) return true;

  // Super wildcard
  if (permissions.includes("*:*")) return true;

  // Admin permission wildcard
  if (permissions.includes("admin:*")) return true;

  // Resource wildcard
  if (permissions.includes(`${resourceType}:*`)) return true;

  // Exact match
  if (permissions.includes(`${resourceType}:${action}`)) return true;

  return false;
}

/**
 * Check if user has access to a specific resource
 * Combines role permissions and resource-level permissions
 */
export async function hasResourceAccess(
  userId: string,
  resourceType: ResourceType,
  resourceId: string,
  requiredAction: "view" | "edit" | "execute" | "admin" | "delete" = "view"
): Promise<boolean> {
  // Check if user is admin
  if (await isAdmin(userId)) {
    return true;
  }

  const { rolePermissions, resourcePermissions } = await getUserPermissions(userId);

  // Check role permissions first
  if (hasPermission(rolePermissions, resourceType, requiredAction)) {
    return true;
  }

  // Check resource-level permissions
  const resourcePerm = resourcePermissions.find(
    (p) => p.resource_type === resourceType && p.resource_id === resourceId
  );

  if (resourcePerm) {
    const permissionLevel = resourcePerm.permission_level;

    // Permission hierarchy: admin > edit > execute > view
    const permissionStrength: Record<PermissionLevel, number> = {
      view: 1,
      execute: 2,
      edit: 3,
      admin: 4,
    };

    const requiredStrength = permissionStrength[requiredAction as PermissionLevel] ?? 0;
    const grantedStrength = permissionStrength[permissionLevel as PermissionLevel] ?? 0;

    return grantedStrength >= requiredStrength;
  }

  return false;
}

/**
 * Filter list of resources based on user permissions
 */
export async function filterAccessibleResources<T extends { id: string }>(
  userId: string,
  resources: T[],
  resourceType: ResourceType,
  action: "view" | "edit" | "execute" | "admin" | "delete" = "view"
): Promise<T[]> {
  if (await isAdmin(userId)) {
    return resources;
  }

  const { rolePermissions, resourcePermissions } = await getUserPermissions(userId);

  // If user has wildcard permission for this resource type, return all
  if (hasPermission(rolePermissions, resourceType, action)) {
    return resources;
  }

  // Filter based on resource-level permissions
  const permittedResourceIds = resourcePermissions
    .filter((p) => p.resource_type === resourceType)
    .filter((p) => {
      const permissionLevel = p.permission_level;
      const permissionStrength: Record<string, number> = {
        view: 1,
        execute: 2,
        edit: 3,
        admin: 4,
      };
      const requiredStrength = permissionStrength[action] ?? 0;
      const grantedStrength = permissionStrength[permissionLevel] ?? 0;
      return grantedStrength >= requiredStrength;
    })
    .map((p) => p.resource_id);

  return resources.filter((r) => permittedResourceIds.includes(r.id));
}

/**
 * Check if user can create resources of a given type
 */
export async function canCreateResource(
  userId: string,
  resourceType: ResourceType
): Promise<boolean> {
  if (await isAdmin(userId)) {
    return true;
  }

  const { rolePermissions } = await getUserPermissions(userId);

  // Check if user has edit or admin permission on resource type
  return (
    hasPermission(rolePermissions, resourceType, "edit") ||
    hasPermission(rolePermissions, resourceType, "admin") ||
    hasPermission(rolePermissions, resourceType, "create") // Support create action explicitly
  );
}

/**
 * Check if user can delete a resource
 */
export async function canDeleteResource(
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Promise<boolean> {
  return hasResourceAccess(userId, resourceType, resourceId, "admin");
}

/**
 * Middleware helper to check permissions and return error response if denied
 */
export function requirePermission(
  resourceType: ResourceType,
  action: "view" | "edit" | "execute" | "admin" | "delete" = "view"
) {
  return async (userId: string, resourceId?: string) => {
    // Admin always has access
    if (await isAdmin(userId)) {
      return { allowed: true };
    }

    // If resourceId is provided, check resource-level access
    if (resourceId) {
      const hasAccess = await hasResourceAccess(userId, resourceType, resourceId, action);
      if (hasAccess) {
        return { allowed: true };
      }
      return {
        allowed: false,
        error: `You do not have ${action} permission for this ${resourceType}`,
      };
    }

    // Otherwise check role permissions
    const { rolePermissions } = await getUserPermissions(userId);
    if (hasPermission(rolePermissions, resourceType, action)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      error: `You do not have ${action} permission for ${resourceType}`,
    };
  };
}
