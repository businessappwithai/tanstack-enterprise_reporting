import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql } from "kysely";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { JOB_TYPES } from "@/lib/jobs/job-vocabulary";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { json } from "@/lib/server/response";

const MAX_TARGETS = 10;

function fail(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status });
}

/** `%` and `_` in a search term are the user's characters, not wildcards. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const Route = createFileRoute("/api/jobs/targets")({
  server: {
    handlers: {
      // What a job can point at, by name: the lookup the assistant needs to turn "the weekly
      // sales report" into a target_id. Searched at the database, at most ten at a time.
      GET: withApiHandler("/api/jobs/targets", async ({ request }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "job", "view");
          if (denied) return denied;

          const params = new URL(request.url).searchParams;
          const type = params.get("type");
          if (type !== "report" && type !== "export") {
            return fail(400, "INVALID_INPUT", `type must be one of: ${JOB_TYPES.join(", ")}`);
          }
          const search = (params.get("search") ?? "").trim().slice(0, 100);

          // The targets are reports or saved queries, so seeing them takes that permission too.
          const notAllowed = refuseWithoutPermission(
            session.user,
            type === "report" ? "report" : "query",
            "view"
          );
          if (notAllowed) return notAllowed;

          const db = getDb();
          const items =
            type === "report"
              ? await db
                  .selectFrom("report_definitions")
                  .select(["id", "name"])
                  .where("saved_query_id", "is not", null)
                  .$if(search !== "", (qb) =>
                    qb.where(sql<boolean>`name ILIKE ${likePattern(search)} ESCAPE '\\'`)
                  )
                  .orderBy("name")
                  .limit(MAX_TARGETS)
                  .execute()
              : await db
                  .selectFrom("saved_queries")
                  .select(["id", "name"])
                  .where((eb) => eb.or([eb("is_deleted", "is", null), eb("is_deleted", "=", false)]))
                  .$if(search !== "", (qb) =>
                    qb.where(sql<boolean>`name ILIKE ${likePattern(search)} ESCAPE '\\'`)
                  )
                  .orderBy("name")
                  .limit(MAX_TARGETS)
                  .execute();

          return json({ success: true, data: { items } });
        } catch (error) {
          recordFailure(error, "Error listing job targets:");
          return fail(500, "SERVER_ERROR", "Failed to list job targets");
        }
      }),
    },
  },
});
