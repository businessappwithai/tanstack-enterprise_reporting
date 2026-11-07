/**
 * Runs job definitions on their schedule.
 *
 * `job_definitions` rows used to be inert: nothing read them, so a job created with a cron
 * expression was a row that never fired. (The on-premise cron runner polls `monitoring_rules`
 * and `nl_report_definitions`; Trigger.dev's `addScheduledJobViaTrigger` only logs a line.)
 * This loop is what makes a definition a job. It runs in both modes - neither backend schedules
 * these - and its rules are:
 *
 *   - UTC, five-field cron (`cron.ts`); only the types with a worker (`report`, `export`) - rows
 *     of other types, such as `monitoring:evaluate`, belong to whatever wrote them.
 *   - Each (job, minute) is claimed with one INSERT guarded by a unique index, so a restart
 *     mid-minute, the 20-second polling, or a second process cannot run it twice.
 *   - A job that is still running (and started under an hour ago, so a crash cannot block it
 *     forever) is not started again.
 *   - It runs as its creator. The workers re-check that person's access to the tables every time
 *     (`refuseJobQuery`), so a creator who has since lost access gets a recorded failure and no file.
 *   - Every outcome is a `job_executions` row: completed with its output, or failed with the reason.
 */

import { getDb } from "@/lib/db/config";
import { cronMatches } from "./cron";
import { processExportJob } from "./workers/export-worker";
import { processReportJob } from "./workers/report-worker";
import type { JobResult } from "./types";
import { getLogger } from "@/lib/logging/logger";

const POLL_MS = 20_000;
const STALE_RUNNING_MS = 60 * 60 * 1000;

export interface JobDefinitionRow {
  id: string;
  name: string;
  job_type: string;
  target_id: string;
  schedule_cron: string | null;
  parameters: string | null;
  created_by: string | null;
}

export interface JobRunnerDeps {
  /** Active, not-deleted, scheduled definitions of the types this runner owns. */
  listScheduled(): Promise<JobDefinitionRow[]>;
  /** Is there a `running` execution of this job that started at or after `since`? */
  isRunning(jobId: string, since: Date): Promise<boolean>;
  /** Claim the (job, minute) slot; the execution id, or null if it was already claimed. */
  claim(jobId: string, minute: string, startedAt: string): Promise<string | null>;
  finish(
    executionId: string,
    outcome: { status: "completed" | "failed"; result?: JobResult; error?: string }
  ): Promise<void>;
  runReport(job: JobDefinitionRow, userId: string, format: string): Promise<JobResult>;
  runExport(job: JobDefinitionRow, userId: string, format: string): Promise<JobResult>;
}

export interface RunSummary {
  started: string[];
  skipped: Array<{ jobId: string; reason: "running" | "claimed" }>;
}

function formatOf(job: JobDefinitionRow): string {
  try {
    const format = (JSON.parse(job.parameters ?? "{}") as { format?: unknown }).format;
    return typeof format === "string" ? format : "csv";
  } catch {
    return "csv";
  }
}

/** One tick: start every definition that is due in the minute containing `now`. */
export async function runDueJobDefinitions(
  now: Date,
  deps: JobRunnerDeps = databaseDeps
): Promise<RunSummary> {
  const minuteDate = new Date(now);
  minuteDate.setUTCSeconds(0, 0);
  const minute = minuteDate.toISOString();
  const summary: RunSummary = { started: [], skipped: [] };

  const due = (await deps.listScheduled()).filter((job) => {
    try {
      return job.schedule_cron != null && cronMatches(job.schedule_cron, minuteDate);
    } catch {
      return false;
    }
  });

  await Promise.allSettled(
    due.map(async (job) => {
      try {
        if (await deps.isRunning(job.id, new Date(now.getTime() - STALE_RUNNING_MS))) {
          summary.skipped.push({ jobId: job.id, reason: "running" });
          return;
        }
        const executionId = await deps.claim(job.id, minute, now.toISOString());
        if (!executionId) {
          summary.skipped.push({ jobId: job.id, reason: "claimed" });
          return;
        }
        summary.started.push(job.id);

        try {
          if (!job.created_by) {
            throw new Error("The job has no owner to run as.");
          }
          const format = formatOf(job);
          const result =
            job.job_type === "report"
              ? await deps.runReport(job, job.created_by, format)
              : await deps.runExport(job, job.created_by, format);
          await deps.finish(
            executionId,
            result.success
              ? { status: "completed", result }
              : { status: "failed", result, error: result.error ?? "The job failed." }
          );
        } catch (error) {
          await deps.finish(executionId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        getLogger("jobs").note("error", `[job-runner] job=${job.id} could not be started:`, { err: error });
      }
    })
  );

  if (summary.started.length > 0) {
    getLogger("jobs").note("debug", `[job-runner] ${summary.started.length} job(s) run for ${minute}`);
  }
  return summary;
}

const databaseDeps: JobRunnerDeps = {
  async listScheduled() {
    return getDb()
      .selectFrom("job_definitions")
      .select(["id", "name", "job_type", "target_id", "schedule_cron", "parameters", "created_by"])
      .where("is_active", "=", true)
      .where((eb) => eb.or([eb("is_deleted", "is", null), eb("is_deleted", "=", false)]))
      .where("schedule_cron", "is not", null)
      .where("job_type", "in", ["report", "export"])
      .execute();
  },

  async isRunning(jobId, since) {
    const row = await getDb()
      .selectFrom("job_executions")
      .select("id")
      .where("job_definition_id", "=", jobId)
      .where("status", "=", "running")
      .where("started_at", ">=", since.toISOString())
      .executeTakeFirst();
    return row !== undefined;
  },

  async claim(jobId, minute, startedAt) {
    const id = crypto.randomUUID();
    const row = await getDb()
      .insertInto("job_executions")
      .values({
        id,
        job_definition_id: jobId,
        status: "running",
        started_at: startedAt,
        completed_at: null,
        result_location: null,
        error_message: null,
        execution_metadata: JSON.stringify({ trigger: "schedule" }),
        scheduled_for: minute,
        created_at: startedAt,
      })
      .onConflict((oc) => oc.columns(["job_definition_id", "scheduled_for"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return row?.id ?? null;
  },

  async finish(executionId, outcome) {
    await getDb()
      .updateTable("job_executions")
      .set({
        status: outcome.status,
        completed_at: new Date().toISOString(),
        result_location: outcome.result?.outputLocation ?? null,
        error_message: outcome.error ?? null,
        execution_metadata: JSON.stringify({
          trigger: "schedule",
          rowCount: outcome.result?.rowCount ?? null,
          duration: outcome.result?.duration ?? null,
        }),
      })
      .where("id", "=", executionId)
      .execute();
  },

  runReport: (job, userId, format) =>
    processReportJob({
      type: "report:generate",
      reportId: job.target_id,
      userId,
      format: format as "csv" | "xlsx" | "pdf",
    }),

  runExport: (job, userId, format) =>
    processExportJob({
      type: "data:export",
      queryId: job.target_id,
      userId,
      format: format as "csv" | "xlsx" | "pdf",
    }),
};

let _handle: ReturnType<typeof setInterval> | null = null;

/** Start polling. Safe to call twice. Errors are logged and never stop the loop. */
export function startJobDefinitionRunner(): void {
  if (_handle) return;
  getLogger("jobs").note("debug", `[job-runner] Starting job-definition runner (poll interval: ${POLL_MS / 1000}s, UTC)`);
  const tick = () =>
    runDueJobDefinitions(new Date()).catch((error) =>
      getLogger("jobs").note("error", "[job-runner] tick failed:", { err: error })
    );
  tick();
  _handle = setInterval(tick, POLL_MS);
}

export function stopJobDefinitionRunner(): void {
  if (_handle) clearInterval(_handle);
  _handle = null;
}
