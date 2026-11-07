import fs from "node:fs/promises";
import path from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import { contentTypeFor, resolveOutputFile } from "@/lib/jobs/output-dir";
import {
  refuseUnlessOwnerOrAdmin,
  refuseWithoutPermission,
} from "@/lib/permissions/resource-guard";
import { logAudit } from "@/lib/security/audit";
import { json } from "@/lib/server/response";

function fail(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status });
}

export const Route = createFileRoute("/api/jobs/$id/result")({
  server: {
    handlers: {
      // `$id` is a job *execution*, as the Jobs page's "Download Result" link has it. The file
      // holds data its job's owner was allowed to read when it ran, so it goes to that owner
      // or an administrator - not to anyone who may merely view jobs.
      GET: withApiHandler("/api/jobs/$id/result", async ({ request, params }) => {
        try {
          const session = await auth(request);
          if (!session?.user) return fail(401, "UNAUTHORIZED", "Not authenticated");
          const denied = refuseWithoutPermission(session.user, "job", "view");
          if (denied) return denied;

          const db = getDb();
          const execution = await db
            .selectFrom("job_executions as e")
            .innerJoin("job_definitions as d", "d.id", "e.job_definition_id")
            .select(["e.id", "e.status", "e.result_location", "d.created_by", "d.name"])
            .where("e.id", "=", params.id)
            .executeTakeFirst();
          if (!execution) return fail(404, "NOT_FOUND", "Job execution not found");

          const notYours = refuseUnlessOwnerOrAdmin(session.user, execution.created_by, "job");
          if (notYours) return notYours;

          if (!execution.result_location) {
            return fail(404, "NOT_FOUND", "This execution produced no file");
          }
          const file = resolveOutputFile(execution.result_location);
          if (!file) return fail(404, "NOT_FOUND", "This execution's file is not available");

          let content: Buffer;
          try {
            content = await fs.readFile(file);
          } catch {
            return fail(404, "NOT_FOUND", "The file is no longer on the server");
          }

          await logAudit({
            userId: session.user.id,
            action: "export",
            resourceType: "job",
            resourceId: execution.id,
            details: { job: execution.name, file: path.basename(file) },
          });

          return new Response(new Uint8Array(content), {
            headers: {
              "content-type": contentTypeFor(file),
              "content-length": String(content.byteLength),
              "content-disposition": `attachment; filename="${path.basename(file).replace(/"/g, "")}"`,
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          recordFailure(error, "Error downloading job result:");
          return fail(500, "SERVER_ERROR", "Failed to download the result");
        }
      }),
    },
  },
});
