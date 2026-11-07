import { createFileRoute } from "@tanstack/react-router";
import { appError } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { getDb } from "@/lib/db/config";
import {
  getLogger,
  isChannel,
  isSettableLevel,
  markPersisted,
  resetChannelLevel,
  setChannelLevel,
} from "@/lib/logging/logger";
import { removeLevel, saveLevel } from "@/lib/logging/level-store";
import { setRequestContext } from "@/lib/logging/request-context";
import { isAdminUser } from "@/lib/permissions/resource-guard";
import { json } from "@/lib/server/response";

/**
 * Turn one channel up or down on a running process, until it restarts.
 *
 * An override is kept in the database and applied at start-up (and every half minute, so a
 * second instance follows), unless it is set with `{ "persist": false }`, in which case it lives
 * in this process's memory and is gone when it restarts. Every change is itself logged, with
 * who made it.
 */
async function administrator(request: Request) {
  const session = await auth(request);
  if (!session?.user) throw appError("UNAUTHORIZED", { message: "Not authenticated" });
  setRequestContext({ userId: session.user.id });
  if (!isAdminUser(session.user)) {
    throw appError("FORBIDDEN", { message: "This requires an administrator." });
  }
  return session.user;
}

export const Route = createFileRoute("/api/admin/log-levels/$channel")({
  server: {
    handlers: {
      PUT: withApiHandler("/api/admin/log-levels/$channel", async ({ request, params }) => {
        const user = await administrator(request);
        const { channel } = params as { channel: string };
        if (!isChannel(channel)) {
          throw appError("NOT_FOUND", { message: `There is no log channel "${channel}".` });
        }
        const body = (await request.json()) as { level?: unknown; persist?: unknown };
        if (!isSettableLevel(body?.level)) {
          throw appError("INVALID_INPUT", {
            message: "level must be one of fatal, error, warn, info, debug, trace, silent.",
          });
        }
        const change = setChannelLevel(channel, body.level);

        // Kept across restarts unless the caller says it is temporary ({ "persist": false }).
        const persisted = body.persist === false ? false : await saveLevel(getDb(), channel, body.level, user.id);
        markPersisted(channel, persisted);

        getLogger("logging").event("logging.level.changed", { ...change, by: user.id });
        return json({ success: true, data: { ...change, persisted } });
      }),

      DELETE: withApiHandler("/api/admin/log-levels/$channel", async ({ request, params }) => {
        const user = await administrator(request);
        const { channel } = params as { channel: string };
        if (!isChannel(channel)) {
          throw appError("NOT_FOUND", { message: `There is no log channel "${channel}".` });
        }
        const change = resetChannelLevel(channel);
        await removeLevel(getDb(), channel);
        markPersisted(channel, false);
        getLogger("logging").event("logging.level.changed", { ...change, by: user.id });
        return json({ success: true, data: change });
      }),
    },
  },
});
