import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/config";
import { json } from "@/lib/server/response";
import { validateSQL } from "@/lib/sql/validator";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/sql/validate")({
  server: {
    handlers: {
      POST: withApiHandler("/api/sql/validate", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const body = (await request.json()) as { sql: string; dataSourceId?: string };
          const { sql, dataSourceId } = body;

          if (!sql) {
            return json(
              {
                success: false,
                error: { code: "INVALID_INPUT", message: "SQL content is required" },
              },
              { status: 400 }
            );
          }

          let dialect = "sqlite3";
          if (dataSourceId) {
            const db = getDb();
            const dataSource = await db
              .selectFrom("data_sources")
              .select("client_type")
              .where("id", "=", dataSourceId)
              .executeTakeFirst();
            if (dataSource) {
              dialect = dataSource.client_type;
            }
          }

          const validationResult = validateSQL(sql, dialect);

          return json({ success: true, data: validationResult });
        } catch (error) {
          throw serverFailure(error, "Unknown error");
        }
      }),
    },
  },
});
