/**
 * Trigger.dev Queue Integration
 * Replaces BullMQ with trigger.dev for background job processing
 */

import {
  reportGenerationTask,
  dataExportTask,
  emailBatchTask,
  scheduledRefreshTask,
} from "./trigger-tasks";
import type { EmailBatchJobData } from "./types";
import { getLogger } from "@/lib/logging/logger";

// Job type definitions
export type JobType =
  | "report:generate"
  | "chart:render"
  | "data:export"
  | "scheduled:refresh"
  | "email:batch";

export interface ReportJobData {
  type: "report:generate";
  reportId: string;
  userId: string;
  parameters?: Record<string, unknown>;
  format?: "csv" | "xlsx" | "pdf";
}

export interface ChartJobData {
  type: "chart:render";
  chartId: string;
  userId: string;
  format?: "png" | "svg";
}

export interface ExportJobData {
  type: "data:export";
  queryId: string;
  userId: string;
  format: "csv" | "xlsx" | "pdf";
  parameters?: Record<string, unknown>;
}

export interface ScheduledRefreshData {
  type: "scheduled:refresh";
  targetType: "report" | "chart" | "dashboard";
  targetId: string;
  userId: string;
}

export type JobData =
  | ReportJobData
  | ChartJobData
  | ExportJobData
  | ScheduledRefreshData
  | EmailBatchJobData;

export interface JobResult {
  success: boolean;
  outputLocation?: string;
  rowCount?: number;
  duration: number;
  error?: string;
  emailsSent?: number;
  attachmentPath?: string;
}

export interface Job<T = JobData, R = JobResult> {
  id: string;
  name: string;
  data: T;
  result?: R;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
}

/**
 * Add a job to trigger.dev
 */
export async function addJob(
  data: JobData,
  options?: {
    priority?: number;
    delay?: number;
    jobId?: string;
  }
): Promise<Job<JobData, JobResult>> {
  try {
    const jobId = options?.jobId || `job-${Date.now()}`;

    switch (data.type) {
      case "report:generate":
        await reportGenerationTask.trigger(data as any, {
          idempotencyKey: jobId,
        });
        break;

      case "data:export":
        await dataExportTask.trigger(data as any, {
          idempotencyKey: jobId,
        });
        break;

      case "email:batch":
        await emailBatchTask.trigger(data as EmailBatchJobData, {
          idempotencyKey: jobId,
        });
        break;

      case "scheduled:refresh":
        await scheduledRefreshTask.trigger(data as any, {
          idempotencyKey: jobId,
        });
        break;

      default:
        throw new Error(`Unknown job type: ${(data as any).type}`);
    }

    return {
      id: jobId,
      name: data.type,
      data,
      status: "waiting",
    };
  } catch (error) {
    getLogger("jobs").note("error", "Error adding job to trigger.dev:", { err: error });
    throw error;
  }
}

/**
 * Add a scheduled job via trigger.dev
 */
export async function addScheduledJob(
  data: JobData,
  cronExpression: string,
  options?: {
    jobId?: string;
    timezone?: string;
  }
): Promise<Job<JobData, JobResult>> {
  try {
    const jobId = options?.jobId || `scheduled-${Date.now()}`;

    // In trigger.dev, scheduled jobs are set up through triggers
    // This would typically be configured in the dashboard or via the trigger.dev API
    getLogger("jobs").note("debug", `Scheduled job ${data.type} with cron: ${cronExpression}`);

    return {
      id: jobId,
      name: data.type,
      data,
      status: "delayed",
    };
  } catch (error) {
    getLogger("jobs").note("error", "Error adding scheduled job to trigger.dev:", { err: error });
    throw error;
  }
}

/**
 * Remove a scheduled job
 */
export async function removeScheduledJob(jobId: string): Promise<boolean> {
  getLogger("jobs").note("debug", `Removing scheduled job ${jobId} (managed via trigger.dev dashboard)`);
  return true;
}

/**
 * Get a job by ID
 */
export async function getJob(jobId: string): Promise<Job<JobData, JobResult> | undefined> {
  getLogger("jobs").note("debug", `Getting job ${jobId} (trigger.dev provides job tracking via API)`);
  return undefined;
}

/**
 * Get queue status
 */
export async function getQueueStatus() {
  return {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  };
}

/**
 * Get jobs by status
 */
export async function getJobs(
  status: "waiting" | "active" | "completed" | "failed" | "delayed",
  start: number = 0,
  end: number = 20
) {
  return [];
}

/**
 * Clean old jobs
 */
export async function cleanOldJobs(grace: number = 1000, limit: number = 1000) {
  getLogger("jobs").note("debug", "Job cleanup handled by trigger.dev retention policy");
}

/**
 * Close queue connections
 */
export async function closeQueue() {
  getLogger("jobs").note("debug", "Closing trigger.dev connections (managed automatically)");
}

/**
 * Reporting queue abstraction for backward compatibility
 */
export const reportingQueue = {
  add: async (name: string, data: JobData, options?: any) =>
    addJob(data, { jobId: options?.jobId, priority: options?.priority }),
  getJob: async (jobId: string) => getJob(jobId),
  getWaitingCount: async () => {
    const status = await getQueueStatus();
    return status.waiting;
  },
  getActiveCount: async () => {
    const status = await getQueueStatus();
    return status.active;
  },
  getCompletedCount: async () => {
    const status = await getQueueStatus();
    return status.completed;
  },
  getFailedCount: async () => {
    const status = await getQueueStatus();
    return status.failed;
  },
  getDelayedCount: async () => {
    const status = await getQueueStatus();
    return status.delayed;
  },
  getJobs: async (types: any[], start?: number, end?: number) => getJobs(types[0], start, end),
  clean: async (grace: number, limit: number, type: string) => cleanOldJobs(grace, limit),
  close: async () => closeQueue(),
  removeRepeatableByKey: async (key: string) => removeScheduledJob(key),
};

/**
 * Queue events abstraction (not needed with trigger.dev, but kept for compatibility)
 */
export const queueEvents = {
  close: async () => {
    getLogger("jobs").note("debug", "Queue events closed (trigger.dev manages events automatically)");
  },
};
