import { useCallback } from "react";
import { getLogger } from "@/lib/logging/logger";

interface LogContext {
  component: string;
}

export function useLogger(context: LogContext) {
  const sendLog = useCallback(
    async (
      level: "info" | "warn" | "error" | "debug",
      message: string,
      metadata?: Record<string, unknown>
    ) => {
      try {
        await fetch("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level,
            message,
            component: context.component,
            metadata,
          }),
        });
      } catch (error) {
        getLogger("client").event("client.ui.failed", { what: "", err: error });
      }
    },
    [context.component]
  );

  return {
    info: (message: string, metadata?: Record<string, unknown>) =>
      sendLog("info", message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) =>
      sendLog("warn", message, metadata),
    error: (message: string, metadata?: Record<string, unknown>) =>
      sendLog("error", message, metadata),
    debug: (message: string, metadata?: Record<string, unknown>) =>
      sendLog("debug", message, metadata),
  };
}
