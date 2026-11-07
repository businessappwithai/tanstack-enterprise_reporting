import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { runADKPipeline } from "@/lib/adk/pipeline";
import { logAudit } from "@/lib/security/audit";
import { AUDIT_ACTIONS } from "@/types/actions";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/adk/analyze-intent")({
  server: {
    handlers: {
      POST: withApiHandler("/api/adk/analyze-intent", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) return json({ error: "Unauthorized" }, { status: 401 });

          const body = (await request.json()) as {
            nlRequest?: string;
            dataSourceId?: string;
            sessionId?: string;
          };

          if (!body.nlRequest?.trim()) {
            return json({ error: "nlRequest is required and must be non-empty" }, { status: 400 });
          }
          if (!body.dataSourceId) {
            return json({ error: "dataSourceId is required" }, { status: 400 });
          }

          await logAudit({
            userId: session.user.id,
            action: AUDIT_ACTIONS.ADK.INTENT_RECEIVED,
            resourceType: "adk_intent" as any,
            details: { dataSourceId: body.dataSourceId, requestLength: body.nlRequest.length },
          });

          const result = await runADKPipeline(
            body.nlRequest.trim(),
            session.user.id,
            body.dataSourceId,
            body.sessionId,
            { dryRun: true }
          );

          return json(result, {
            status: result.success ? 200 : result.clarificationNeeded ? 200 : 422,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "ADK pipeline failed";
          recordFailure(err, "[/api/adk/analyze-intent]");
          return json({ success: false, error: msg }, { status: 500 });
        }
      }),
    },
  },
});
