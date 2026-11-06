import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/server/response";
import {
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/charts/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "view");
          if (denied) return denied;

          const { searchParams } = new URL(request.url);
          const page = parseInt(searchParams.get("page") || "0", 10);
          const pageSize = parseInt(searchParams.get("pageSize") || "20", 10);

          const db = getDb();

          const charts = await db
            .selectFrom("chart_definitions")
            .selectAll()
            .orderBy("created_at", "desc")
            // A tie-breaker: rows seeded together share a timestamp, and without one the order of equal rows
            // is not stable between pages, so offset pagination skips some and repeats others.
            .orderBy("id", "desc")
            .limit(pageSize)
            .offset(page * pageSize)
            .execute();

          const countResult = await db
            .selectFrom("chart_definitions")
            .select(db.fn.count<number>("id").as("count"))
            .executeTakeFirstOrThrow();
          const total = Number(countResult.count);

          return json({
            success: true,
            data: {
              items: charts,
              meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
            },
          });
        } catch (error) {
          console.error("Error fetching charts:", error);
          return json(
            { success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch charts" } },
            { status: 500 }
          );
        }
      },

      POST: async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const denied = refuseWithoutPermission(session.user, "chart", "create");
          if (denied) return denied;

          const body = (await request.json()) as {
            name: string;
            description?: string;
            chart_type: string;
            chart_config: object;
            saved_query_id?: string;
            data_mapping?: object;
          };

          if (!body.name || !body.chart_type || !body.chart_config) {
            return json(
              {
                success: false,
                error: { message: "Missing required fields: name, chart_type, chart_config" },
              },
              { status: 400 }
            );
          }

          const { randomUUID } = await import("node:crypto");
          const db = getDb();
          const id = randomUUID();
          const now = new Date().toISOString();

          await db
            .insertInto("chart_definitions")
            .values({
              id,
              name: body.name,
              description: body.description || null,
              chart_type: body.chart_type,
              chart_config: JSON.stringify(body.chart_config),
              saved_query_id: body.saved_query_id || null,
              data_mapping: body.data_mapping
                ? JSON.stringify(body.data_mapping)
                : JSON.stringify({ xAxis: { field: "" }, yAxis: [] }),
              created_by: session.user.id,
              created_at: now,
              updated_at: now,
            })
            .executeTakeFirstOrThrow();

          return json(
            {
              success: true,
              data: { id },
            },
            { status: 201 }
          );
        } catch (error) {
          console.error("Error creating chart:", error);
          return json(
            { success: false, error: { code: "SERVER_ERROR", message: "Failed to create chart" } },
            { status: 500 }
          );
        }
      },
    },
  },
});
