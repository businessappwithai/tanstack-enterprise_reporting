import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { refuseWithoutDataSourcePermission } from "@/lib/permissions/data-source-guard";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";

async function getSession(request: Request) {
  return auth(request);
}

export const Route = createFileRoute("/api/data-sources/upload")({
  server: {
    handlers: {
      POST: withApiHandler("/api/data-sources/upload", async ({ request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const refusal = refuseWithoutDataSourcePermission(session.user, "create");
          if (refusal) return refusal;

          const formData = await request.formData();
          const file = formData.get("file") as File | null;

          if (!file) {
            return json(
              { success: false, error: { message: "No file provided" } },
              { status: 400 }
            );
          }

          // Validate file type (SQLite database files)
          const validExtensions = [".db", ".sqlite", ".sqlite3"];
          const fileName = file.name;
          const isValidFile = validExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));

          if (!isValidFile) {
            return json(
              {
                success: false,
                error: {
                  message:
                    "Invalid file type. Please upload a SQLite database file (.db, .sqlite, .sqlite3)",
                },
              },
              { status: 400 }
            );
          }

          // For now, just return the filename - the file is stored client-side in a File object
          // In a production system, you would store the file on the server and return a path
          return json(
            {
              success: true,
              data: {
                filename: fileName,
                message: "File accepted. The database will be referenced by this name.",
              },
            },
            { status: 201 }
          );
        } catch (error) {
          throw serverFailure(error, "Failed to upload data source");
        }
      }),
    },
  },
});
