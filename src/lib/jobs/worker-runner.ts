/**
 * Worker Runner
 *
 * Initialises background job processing.  Two backends are supported:
 *
 *   1. Trigger.dev (self-hosted) — used when TRIGGER_API_URL is set.
 *      Task definitions are registered and the platform manages scheduling.
 *
 *   2. On-premise cron runner (built-in fallback) — activated automatically
 *      when TRIGGER_API_URL is not set.  A pure-Bun interval loop polls
 *      monitoring_rules every minute and executes due rules in-process.
 */

import {
  reportGenerationTask,
  dataExportTask,
  emailBatchTask,
  scheduledRefreshTask,
} from "./trigger-tasks";
import { getLogger } from "@/lib/logging/logger";
import { startJobDefinitionRunner, stopJobDefinitionRunner } from "./job-definition-runner";
import {
  startOnPremiseCronRunner,
  stopOnPremiseCronRunner,
} from "@/lib/monitoring/monitoring-scheduler";

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);

function isTriggerDevConfigured(): boolean {
  return Boolean(process.env.TRIGGER_API_URL?.trim());
}

export async function initializeWorkers(): Promise<void> {
  // Job definitions are scheduled by neither backend below, so this runs in both modes.
  startJobDefinitionRunner();

  const backend = isTriggerDevConfigured() ? "trigger.dev" : "on-premise cron";
  if (backend === "on-premise cron") startOnPremiseCronRunner();

  getLogger("jobs").event("jobs.workers.started", { backend, concurrency: WORKER_CONCURRENCY });
}

export async function shutdownWorkers(): Promise<void> {
  stopOnPremiseCronRunner();
  stopJobDefinitionRunner();
  getLogger("jobs").event("jobs.workers.stopped");
}

export async function checkWorkerHealth(): Promise<{ healthy: boolean; message: string }> {
  if (isTriggerDevConfigured()) {
    return {
      healthy: true,
      message: `Trigger.dev workers active (self-hosted: ${process.env.TRIGGER_API_URL})`,
    };
  }
  return {
    healthy: true,
    message: "On-premise cron runner active (poll interval: 60s)",
  };
}

export { reportGenerationTask, dataExportTask, emailBatchTask, scheduledRefreshTask };
