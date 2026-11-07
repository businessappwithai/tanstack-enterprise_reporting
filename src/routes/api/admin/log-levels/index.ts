import { createFileRoute } from "@tanstack/react-router";
import { appError } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { getChannelLevels } from "@/lib/logging/logger";
import { setRequestContext } from "@/lib/logging/request-context";
import { isAdminUser } from "@/lib/permissions/resource-guard";
import { json } from "@/lib/server/response";

/**
 * Every log channel, its declared level and what it logs at now.
 *
 * Administrators only, reads included: which subsystems are being watched is not for
 * everyone. Changing a level is `PUT /api/admin/log-levels/:channel`.
 */
export const Route = createFileRoute("/api/admin/log-levels/")({
  server: {
    handlers: {
      GET: withApiHandler("/api/admin/log-levels/", async ({ request }) => {
        const session = await auth(request);
        if (!session?.user) throw appError("UNAUTHORIZED", { message: "Not authenticated" });
        setRequestContext({ userId: session.user.id });
        if (!isAdminUser(session.user)) {
          throw appError("FORBIDDEN", { message: "This requires an administrator." });
        }
        return json({ success: true, data: getChannelLevels() });
      }),
    },
  },
});
