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
import { startJobDefinitionRunner, stopJobDefinitionRunner } from "./job-definition-runner";
import {
  startOnPremiseCronRunner,
  stopOnPremiseCronRunner,
} from "@/lib/monitoring/monitoring-scheduler";
import { getLogger } from "@/lib/logging/logger";

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);

function isTriggerDevConfigured(): boolean {
  return Boolean(process.env.TRIGGER_API_URL?.trim());
}

export async function initializeWorkers(): Promise<void> {
  getLogger("jobs").note("debug", "✓ Trigger.dev task definitions loaded");
  getLogger("jobs").note("debug", `  - reportGenerationTask (concurrency: ${WORKER_CONCURRENCY})`);
  getLogger("jobs").note("debug", `  - dataExportTask (concurrency: ${WORKER_CONCURRENCY})`);
  getLogger("jobs").note("debug", `  - emailBatchTask (concurrency: ${WORKER_CONCURRENCY})`);
  getLogger("jobs").note("debug", `  - scheduledRefreshTask (concurrency: ${WORKER_CONCURRENCY})`);

  // Job definitions are scheduled by neither backend below, so this runs in both modes.
  startJobDefinitionRunner();

  if (isTriggerDevConfigured()) {
    getLogger("jobs").note("debug", "");
    getLogger("jobs").note("debug", "Jobs are now being processed by Trigger.dev (self-hosted):");
    getLogger("jobs").note("debug", `  - TRIGGER_API_URL: ${process.env.TRIGGER_API_URL}`);
    getLogger("jobs").note("debug", "  - Configure retries and timeouts in trigger.config.ts");
  } else {
    getLogger("jobs").note("debug", "");
    getLogger("jobs").note("debug", "TRIGGER_API_URL not set — starting on-premise cron runner as fallback.");
    startOnPremiseCronRunner();
  }
}

export async function shutdownWorkers(): Promise<void> {
  getLogger("jobs").note("debug", "Shutting down workers...");
  stopOnPremiseCronRunner();
  stopJobDefinitionRunner();
  getLogger("jobs").note("debug", "✓ Workers stopped");
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
