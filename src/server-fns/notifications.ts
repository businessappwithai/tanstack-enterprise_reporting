import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { getLogger } from "@/lib/logging/logger";

async function getSession() {
  const cookie = getRequestHeader("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const fetchNotificationsFn = createServerFn({ method: "GET" })
  .inputValidator((data: { includeRead?: boolean }) => data)
  .handler(async ({ data: { includeRead = false } }) => {
    try {
      const session = await getSession();
      if (!session?.user) {
        return { success: false, data: [], error: "Unauthorized" };
      }

      const db = getDb();
      let query = (db as any)
        .selectFrom("notifications")
        .where("user_id", "=", session.user.id)
        .orderBy("created_at", "desc")
        .limit(50);

      if (!includeRead) {
        query = query.where("is_read", "=", 0);
      }

      const rows = await query.selectAll().execute();
      return { success: true, data: rows };
    } catch (error) {
      getLogger("app").event("app.serverfn.failed", { what: "Error fetching notifications", err: error });
      return {
        success: false,
        data: [],
        error: error instanceof Error ? error.message : "Failed to fetch notifications",
      };
    }
  });

export const markNotificationAsReadFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data: { id } }) => {
    try {
      const session = await getSession();
      if (!session?.user) {
        return { success: false, error: "Unauthorized" };
      }

      const db = getDb();
      await (db as any)
        .updateTable("notifications")
        .set({ is_read: 1 })
        .where("id", "=", id)
        .where("user_id", "=", session.user.id)
        .execute();

      return { success: true };
    } catch (error) {
      getLogger("app").event("app.serverfn.failed", { what: "Error marking notification as read", err: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update notification",
      };
    }
  });

export const markAllNotificationsAsReadFn = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const session = await getSession();
    if (!session?.user) {
      return { success: false, error: "Unauthorized" };
    }

    const db = getDb();
    await (db as any)
      .updateTable("notifications")
      .set({ is_read: 1 })
      .where("user_id", "=", session.user.id)
      .where("is_read", "=", 0)
      .execute();

    return { success: true };
  } catch (error) {
    getLogger("app").event("app.serverfn.failed", { what: "Error marking all notifications as read", err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update notifications",
    };
  }
});

export const deleteNotificationFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data: { id } }) => {
    try {
      const session = await getSession();
      if (!session?.user) {
        return { success: false, error: "Unauthorized" };
      }

      const db = getDb();
      await (db as any)
        .deleteFrom("notifications")
        .where("id", "=", id)
        .where("user_id", "=", session.user.id)
        .execute();

      return { success: true };
    } catch (error) {
      getLogger("app").event("app.serverfn.failed", { what: "Error deleting notification", err: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete notification",
      };
    }
  });
