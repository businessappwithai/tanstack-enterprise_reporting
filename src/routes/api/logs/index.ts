import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { allowClientLog, clientLogSchema, withClientSource } from "@/lib/logging/client-log";
import { applyScope, scopeFor, shapeForViewer } from "@/lib/logging/log-access";
import { json } from "@/lib/server/response";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { sqlEditorConfig, validatePageSize } from "@/lib/config/pagination";
import { generateId } from "@/lib/utils";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/logs/")({
  server: {
    handlers: {
      POST: withApiHandler("/api/logs/", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          // Any signed-in user may write here (the browser logger does), so the entry is
          // validated, labelled as client-sourced and rate-limited. See lib/logging/client-log.ts.
          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            return json(
              { success: false, error: { code: "INVALID_INPUT", message: "Body must be JSON" } },
              { status: 400 }
            );
          }
          const parsed = clientLogSchema.safeParse(raw);
          if (!parsed.success) {
            return json(
              {
                success: false,
                error: {
                  code: "INVALID_INPUT",
                  message: parsed.error.issues
                    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
                    .join("; "),
                },
              },
              { status: 400 }
            );
          }
          if (!allowClientLog(session.user.id)) {
            return json(
              {
                success: false,
                error: { code: "RATE_LIMITED", message: "Too many log entries; slow down" },
              },
              {
                status: 429,
                headers: { "content-type": "application/json", "Retry-After": "60" },
              }
            );
          }
          const body = parsed.data;

          const db = getDb();

          await db
            .insertInto("logs")
            .values({
              id: generateId(),
              timestamp: new Date().toISOString(),
              level: body.level,
              message: body.message,
              component: body.component,
              user_id: session.user.id as any,
              metadata: JSON.stringify(withClientSource(body.metadata)),
              error_stack: body.errorStack,
            })
            .execute();

          return json({ success: true });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),

      GET: withApiHandler("/api/logs/", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "log", "view");
          if (denied) return denied;

          const url = new URL(request.url);
          const level = url.searchParams.get("level");
          const component = url.searchParams.get("component");
          const userId = url.searchParams.get("userId");
          const requestId = url.searchParams.get("requestId");
          const category = url.searchParams.get("category");
          const code = url.searchParams.get("code");
          const limit = validatePageSize(parseInt(url.searchParams.get("limit") || "100", 10));
          const offset = parseInt(url.searchParams.get("offset") || "0", 10);

          const db = getDb();

          // Determine admin status from session roles (roles are stored as strings)
          const sessionRoles: string[] = (session.user as any).roles ?? [];
          const isAdmin = sessionRoles.some((r) => r.toLowerCase().includes("admin"));

          // What this viewer may read: an administrator everything, anyone else their own rows,
          // the system's warnings and errors, and a request whose reference they hold. See
          // lib/logging/log-access.ts.
          const viewer = { id: session.user.id, isAdmin };
          const scope = scopeFor(viewer, { userId, requestId });
          const filterByUserId = session.user.id;

          // ── 1. application logs ──────────────────────────────────────────────
          let query = applyScope(db.selectFrom("logs").selectAll(), scope);

          if (level && level !== "info") {
            query = query.where("level", "=", level);
          }
          if (component) {
            query = query.where("component", "=", component);
          }
          // Quote the reference an error showed to find what happened to that request.
          if (requestId) query = query.where("request_id", "=", requestId.slice(0, 64));
          if (category) query = query.where("category", "=", category);
          if (code) query = query.where("code", "=", code);

          const appLogs = await query
            .orderBy("timestamp", "desc")
            .limit(limit)
            .offset(offset)
            .execute();

          // ── 2. audit log entries (resource create/update/delete) ─────────────
          // Audit rows hold what a person did to a record. An ordinary user sees theirs; an
          // administrator sees everyone's, or one person's when they pick one.
          let auditQuery = db.selectFrom("audit_log").selectAll();
          if (!isAdmin) auditQuery = auditQuery.where("user_id", "=", filterByUserId as any);
          else if (userId) auditQuery = auditQuery.where("user_id", "=", userId as any);

          if (component) {
            auditQuery = auditQuery.where("resource_type", "=", component as any);
          }

          // Audit rows carry no request id, so a lookup by reference has none to show.
          const auditLogs = requestId
            ? []
            : await auditQuery.orderBy("created_at", "desc").limit(limit).execute();

          // Map audit_log rows to the Log shape expected by LogsViewer
          const auditAsLogs = auditLogs.map((a) => ({
            id: `audit-${a.id}`,
            timestamp: a.created_at,
            level: "info" as const,
            message: `${a.action} ${a.resource_type}${a.resource_id ? ` (${a.resource_id.slice(0, 8)}…)` : ""}`,
            component: a.resource_type,
            user_id: a.user_id ?? null,
            user_email: null as string | null,
            metadata: a.details ?? null,
            error_stack: null as string | null,
          }));

          // Merge, sort by time desc, slice to page
          const merged = [
            ...appLogs.map((l) => ({ ...l, user_email: null as string | null })),
            ...auditAsLogs,
          ]
            .sort((a, b) => {
              const ta = new Date(a.timestamp).getTime();
              const tb = new Date(b.timestamp).getTime();
              return tb - ta;
            })
            .slice(offset, offset + limit);

          const totalCount = appLogs.length + auditLogs.length;

          // Enrich with user email
          const userCache = new Map<string, string>();
          const logsWithEmail = await Promise.all(
            merged.map(async (log) => {
              if (!log.user_id) return shapeForViewer(viewer, { ...log, user_email: "system" });
              const uid = String(log.user_id);
              if (!userCache.has(uid)) {
                const user = await db
                  .selectFrom("users")
                  .select(["id", "email"])
                  .where("id", "=", uid as any)
                  .executeTakeFirst();
                userCache.set(uid, user?.email ?? "unknown");
              }
              return shapeForViewer(viewer, { ...log, user_email: userCache.get(uid) ?? "unknown" });
            })
          );

          return json({
            success: true,
            data: {
              logs: logsWithEmail,
              pagination: {
                limit,
                offset,
                totalCount,
                hasMore: offset + merged.length < totalCount,
              },
            },
          });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),
    },
  },
});
