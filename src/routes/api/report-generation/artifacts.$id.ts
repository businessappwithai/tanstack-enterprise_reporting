import * as fs from "node:fs";
import { createFileRoute } from "@tanstack/react-router";
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

const MIME_TYPES: Record<string, string> = {
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv",
};

export const Route = createFileRoute("/api/report-generation/artifacts/$id")({
  server: {
    handlers: {
      GET: withApiHandler("/api/report-generation/artifacts/$id", async ({ request, params }: { request: Request; params: { id: string } }) => {
        const session = await getSession(request);
        if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

        const db = getDb();
        const { id } = params;
        const url = new URL(request.url);
        const download = url.searchParams.get("download") === "true";
        const format = url.searchParams.get("format");

        if (download && format) {
          // Download a specific artifact file
          const artifact = await (db as any)
            .selectFrom("generated_report_artifacts")
            .where("id", "=", id)
            .selectAll()
            .executeTakeFirst();

          if (!artifact) return json({ error: "Artifact not found" }, { status: 404 });

          // RBAC: owner or admin
          const isAdmin = (session.user as any).roles?.some((r: any) => {
            const n = (typeof r === "string" ? r : r.name || "").toLowerCase();
            return n === "admin" || n === "administrator" || n.startsWith("admin");
          });

          if (!isAdmin && artifact.created_by !== session.user.id) {
            return json({ error: "Forbidden" }, { status: 403 });
          }

          // Additionally verify the user still has data source access via ds_user_roles
          if (!isAdmin) {
            const definition = await (db as any)
              .selectFrom("nl_report_definitions")
              .where("id", "=", artifact.report_definition_id)
              .select(["data_source_id"])
              .executeTakeFirst();

            if (definition) {
              const dsAccess = await (db as any)
                .selectFrom("ds_user_roles")
                .where("data_source_id", "=", definition.data_source_id)
                .where("user_id", "=", session.user.id)
                .selectAll()
                .executeTakeFirst();

              if (!dsAccess) {
                return json({ error: "Data source access revoked" }, { status: 403 });
              }
            }
          }

          // Stream file
          try {
            const fileBuffer = fs.readFileSync(artifact.file_path);
            const ext = artifact.format === "excel" ? "xlsx" : artifact.format;
            const mimeType = MIME_TYPES[artifact.format] || "application/octet-stream";

            const ts = new Date(artifact.created_at);
            const datePart = ts.toISOString().slice(0, 10);
            const timePart = ts.toISOString().slice(11, 19).replace(/:/g, "-");
            const filename = `report_${datePart}_${timePart}.${ext}`;

            return new Response(fileBuffer, {
              headers: {
                "Content-Type": mimeType,
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": String(fileBuffer.length),
              },
            });
          } catch {
            return json({ error: "File not found on disk" }, { status: 404 });
          }
        }

        // List all artifacts for a report definition
        const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
        const pageSize = Math.min(
          100,
          Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10))
        );

        const artifacts = await (db as any)
          .selectFrom("generated_report_artifacts")
          .where("report_definition_id", "=", id)
          .selectAll()
          .orderBy("created_at", "desc")
          .limit(pageSize)
          .offset(page * pageSize)
          .execute();

        const countResult = await (db as any)
          .selectFrom("generated_report_artifacts")
          .where("report_definition_id", "=", id)
          .select((eb: any) => [eb.fn.count("id").as("total")])
          .executeTakeFirst();

        // Group by execution_id
        const executionMap = new Map<string, any>();
        for (const artifact of artifacts) {
          if (!executionMap.has(artifact.execution_id)) {
            executionMap.set(artifact.execution_id, {
              executionId: artifact.execution_id,
              createdAt: artifact.created_at,
              status: artifact.status,
              rowCount: artifact.row_count,
              executionMs: artifact.execution_ms,
              triggeredBy: artifact.triggered_by,
              artifacts: [],
            });
          }
          const artExt = artifact.format === "excel" ? "xlsx" : artifact.format;
          const artTs = new Date(artifact.created_at);
          const artDate = artTs.toISOString().slice(0, 10);
          const artTime = artTs.toISOString().slice(11, 19).replace(/:/g, "-");
          const suggestedFilename = `report_${artDate}_${artTime}.${artExt}`;

          executionMap.get(artifact.execution_id).artifacts.push({
            id: artifact.id,
            format: artifact.format,
            fileSizeBytes: artifact.file_size_bytes,
            downloadUrl: `/api/report-generation/artifacts/${artifact.id}?download=true&format=${artifact.format}`,
            filename: suggestedFilename,
          });
        }

        return json({
          executions: Array.from(executionMap.values()),
          total: Number(countResult?.total ?? 0),
          page,
          pageSize,
        });
      }),
    },
  },
});
