import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { decideQueryRun } from "@/lib/permissions/runnable-query";
import { refuseWithoutPermission } from "@/lib/permissions/resource-guard";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";
import { idSchema } from "@/lib/schemas/common";

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  savedQueryId: idSchema,
});

function fail(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status });
}

const MAX_PAGE_SIZE = 200;

export const Route = createFileRoute("/api/datasets/")({
  server: {
    handlers: {
      // The list is names and last-download stats; the rows are only ever produced by
      // /api/datasets/:id/data, for whoever is downloading.
      GET: withApiHandler("/api/datasets/", async ({ request }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "query", "view");
          if (denied) return denied;

          const params = new URL(request.url).searchParams;
          const page = Math.max(Number.parseInt(params.get("page") ?? "0", 10) || 0, 0);
          const pageSize = Math.min(
            Math.max(Number.parseInt(params.get("pageSize") ?? "50", 10) || 50, 1),
            MAX_PAGE_SIZE
          );

          const db = getDb();
          // A dataset whose saved query has been deleted has nothing left to run.
          const visible = db
            .selectFrom("datasets as d")
            .innerJoin("saved_queries as q", "q.id", "d.saved_query_id")
            .where((eb) => eb.or([eb("q.is_deleted", "is", null), eb("q.is_deleted", "=", false)]));

          const rows = await visible
            .select([
              "d.id",
              "d.name",
              "d.description",
              "d.saved_query_id",
              "q.data_source_id",
              "d.row_count",
              "d.byte_size",
              "d.columns",
              "d.last_built_at",
              "d.created_by",
              "d.created_at",
            ])
            .orderBy("d.name")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute();
          const total = await visible
            .select((eb) => eb.fn.countAll().as("total"))
            .executeTakeFirst();

          const datasets = rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            savedQueryId: r.saved_query_id,
            dataSourceId: r.data_source_id,
            rowCount: Number(r.row_count),
            fileSize: Number(r.byte_size),
            columns: r.columns ? JSON.parse(r.columns) : [],
            lastBuiltAt: r.last_built_at,
            createdBy: r.created_by,
            status: "ready",
          }));

          return json({
            success: true,
            data: { datasets, meta: { total: Number(total?.total ?? 0), page, pageSize } },
          });
        } catch (error) {
          recordFailure(error, "Error listing datasets:");
          return fail(500, "SERVER_ERROR", "Failed to list datasets");
        }
      }),

      POST: withApiHandler("/api/datasets/", async ({ request }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "query", "create");
          if (denied) return denied;

          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            return fail(400, "INVALID_INPUT", "Body must be JSON");
          }
          const parsed = createSchema.safeParse(raw);
          if (!parsed.success) {
            return fail(
              400,
              "INVALID_INPUT",
              parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
            );
          }
          const { name, description, savedQueryId } = parsed.data;

          const db = getDb();
          const query = await db
            .selectFrom("saved_queries")
            .select(["id", "sql_content", "data_source_id", "is_deleted"])
            .where("id", "=", savedQueryId)
            .executeTakeFirst();
          if (!query || query.is_deleted) return fail(404, "NOT_FOUND", "Saved query not found");

          // Nobody can save a dataset they could not download: the same check the
          // download makes, made now.
          const decision = await decideQueryRun(
            session.user,
            query.sql_content,
            query.data_source_id
          );
          if (!decision.ok) return fail(decision.status, decision.code, decision.message);

          const id = randomUUID();
          const now = new Date().toISOString();
          try {
            await db
              .insertInto("datasets")
              .values({
                id,
                name,
                description: description ?? null,
                saved_query_id: savedQueryId,
                row_count: 0,
                byte_size: 0,
                columns: null,
                last_built_at: null,
                created_by: session.user.id,
                created_at: now,
                updated_at: now,
              })
              .execute();
          } catch (error) {
            if ((error as { code?: string }).code === "23505") {
              return fail(409, "CONFLICT", `A dataset named "${name}" already exists`);
            }
            throw error;
          }

          await logAudit({
            userId: session.user.id,
            action: "create",
            resourceType: "query",
            resourceId: id,
            details: { dataset: name, savedQueryId },
          });

          return json({ success: true, data: { id } }, { status: 201 });
        } catch (error) {
          recordFailure(error, "Error creating dataset:");
          return fail(500, "SERVER_ERROR", "Failed to create dataset");
        }
      }),
    },
  },
});
