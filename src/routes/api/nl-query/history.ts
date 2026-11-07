import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/nl-query/history")({
  server: {
    handlers: {
      GET: withApiHandler("/api/nl-query/history", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
          }

          const url = new URL(request.url);
          const dataSourceId = url.searchParams.get("data_source_id");
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 200);
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const search = url.searchParams.get("search")?.trim() || "";
          // scope=role returns all successful queries for the user's primary role
          const scope = url.searchParams.get("scope") || "role";

          const db = getDb();

          // Primary role from JWT session (no extra DB call needed)
          const primaryRole = session.user.roles?.[0] ?? "viewer";

          let query = db
            .selectFrom("nl_query_context")
            .leftJoin("data_sources", "data_sources.id", "nl_query_context.data_source_id")
            .leftJoin("users", "users.id", "nl_query_context.user_id")
            .select([
              "nl_query_context.id",
              "nl_query_context.nl_question",
              "nl_query_context.generated_sql",
              "nl_query_context.data_source_id",
              "data_sources.name as data_source_name",
              "nl_query_context.role_name",
              "nl_query_context.user_id",
              "users.display_name as user_name",
              "nl_query_context.was_successful",
              "nl_query_context.row_count",
              "nl_query_context.execution_time_ms",
              "nl_query_context.created_at",
            ])
            .where("was_successful", "=", true)
            .orderBy("created_at", "desc")
            .limit(limit)
            .offset(offset);

          if (search) {
            const pattern = `%${search}%`;
            query = query.where((eb) =>
              eb.or([
                eb("nl_query_context.nl_question", "like", pattern),
                eb("nl_query_context.generated_sql", "like", pattern),
              ])
            );
          }

          if (dataSourceId) {
            query = query.where("nl_query_context.data_source_id", "=", dataSourceId);
          }

          if (scope === "role") {
            query = query.where("nl_query_context.role_name", "=", primaryRole);
          } else {
            query = query.where("nl_query_context.user_id", "=", session.user.id);
          }

          const results = await query.execute();

          const totalQuery = db
            .selectFrom("nl_query_context")
            .select(db.fn.countAll().as("count"))
            .where("was_successful", "=", true);

          const [{ count }] = await (dataSourceId
            ? totalQuery.where("data_source_id", "=", dataSourceId)
            : totalQuery
          )
            .where(
              scope === "role" ? "role_name" : "user_id",
              "=",
              scope === "role" ? primaryRole : session.user.id
            )
            .execute();

          return json({
            success: true,
            data: results,
            meta: { total: Number(count), limit, offset },
          });
        } catch (error) {
          throw serverFailure(error, "Failed to fetch history");
        }
      }),

      POST: withApiHandler("/api/nl-query/history", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
          }

          const body = await request.json().catch(() => ({}));
          const {
            nl_question,
            generated_sql,
            data_source_id,
            row_count,
            execution_time_ms,
            was_successful,
          } = body;

          if (!nl_question || !generated_sql) {
            return json(
              { success: false, error: { message: "nl_question and generated_sql are required" } },
              { status: 400 }
            );
          }

          const db = getDb();
          const primaryRole = session.user.roles?.[0] ?? "viewer";

          const id = crypto.randomUUID().replace(/-/g, "");

          await db
            .insertInto("nl_query_context")
            .values({
              id,
              created_at: new Date().toISOString(),
              nl_question,
              generated_sql,
              data_source_id: data_source_id || "",
              user_id: session.user.id,
              role_name: primaryRole,
              schema_context: "{}",
              rbac_context: "{}",
              row_count: row_count ?? 0,
              execution_time_ms: execution_time_ms ?? 0,
              was_successful: was_successful ?? true,
              created_by: session.user.id,
            })
            .execute();

          return json({ success: true, data: { id } });
        } catch (error) {
          throw serverFailure(error, "Failed to save history");
        }
      }),
    },
  },
});
