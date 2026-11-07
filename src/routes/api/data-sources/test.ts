import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { setRequestContext } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { ConnectionTestService } from "@/lib/services/connection-test.service";
import { checkDataSourceHost } from "@/lib/security/network-target";
import { hasPermission } from "@/lib/permissions/permissions";

interface TestConnectionRequest {
  clientType: string;
  connectionConfig: {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    filename?: string;
    connectionString?: string;
  };
}

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/data-sources/test")({
  server: {
    handlers: {
      POST: withApiHandler("/api/data-sources/test", async ({ request }: { request: Request }) => {
        const log = getLogger("datasource");
        const startTime = Date.now();

        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ error: { message: "Unauthorized" } }, { status: 401 });
          }

          setRequestContext({ userId: session.user.id });

          const body = (await request.json().catch(() => null)) as TestConnectionRequest | null;
          // Checked before anything reads body.connectionConfig: this used to throw a TypeError
          // and answer 500 to a request that was simply missing a field.
          if (!body?.clientType || typeof body.connectionConfig !== "object" || !body.connectionConfig) {
            return json(
              { error: { message: "clientType and connectionConfig are required" } },
              { status: 400 }
            );
          }
          /*
           * Two checks this route did not make, both of which it needs because
           * the host and port come straight from the request body.
           *
           * The permission check: testing a connection is part of managing data
           * sources, so it asks for the permission that managing them asks for.
           * Any signed-in account could previously do it.
           *
           * The target check: without it this is a port scanner wearing the
           * server's own network position, and the three distinguishable
           * outcomes — refused, TLS error, authentication failure — are the
           * oracle that makes it a useful one. See
           * src/lib/security/network-target.ts for what is refused and how an
           * operator whose database really is internal turns it off.
           */
          if (
            !hasPermission(
              session.user.permissions ?? [],
              "data_source",
              "create",
              session.user.roles ?? []
            )
          ) {
            log.event("datasource.test.refused", { reason: "missing data_source:create" });
            return json(
              { error: { message: "You do not have permission to manage data sources" } },
              { status: 403 }
            );
          }

          const target = await checkDataSourceHost(body.connectionConfig?.host);
          if (!target.allowed) {
            log.event("datasource.test.refused", { reason: target.reason ?? "target not allowed" });
            return json({ error: { message: target.reason } }, { status: 403 });
          }

          const result = await ConnectionTestService.test(body.clientType, body.connectionConfig);

          const duration = Date.now() - startTime;
          log.event("datasource.test.completed", {
            clientType: body.clientType,
            connected: result.connected,
            durationMs: duration,
          });

          return json({
            data: result,
          });
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : "Test connection failed";
          const errorCode = error instanceof Error ? (error as any).code : "UNKNOWN";

          log.event("datasource.test.failed", { errorCode: String(errorCode ?? "UNKNOWN"), durationMs: duration });

          return json(
            {
              error: {
                message: errorMessage,
              },
            },
            { status: 500 }
          );
        }
      }),
    },
  },
});
