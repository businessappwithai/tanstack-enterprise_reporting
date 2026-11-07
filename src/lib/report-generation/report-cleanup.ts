/**
 * Report Artifact Retention Cleanup
 *
 * Deletes expired artifacts (files + DB records) older than the configured
 * retention period. Designed to run once daily via the on-premise cron runner.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDb } from "@/lib/db/config";
import { getLogger } from "@/lib/logging/logger";

const RETENTION_DAYS = parseInt(process.env.REPORT_ARTIFACT_RETENTION_DAYS || "90", 10);
const OUTPUT_DIR = process.env.JOB_OUTPUT_PATH || "./job-outputs";

function isoNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export async function cleanupExpiredReportArtifacts(): Promise<{
  deletedFiles: number;
  deletedRecords: number;
  errors: string[];
}> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  let deletedFiles = 0;
  let deletedRecords = 0;
  const errors: string[] = [];

  try {
    // Find expired artifacts
    const expired = await (db as any)
      .selectFrom("generated_report_artifacts")
      .where("created_at", "<", cutoff)
      .select(["id", "file_path", "execution_id", "report_definition_id"])
      .execute();

    if (expired.length === 0) return { deletedFiles: 0, deletedRecords: 0, errors: [] };

    getLogger("report").note("debug", `[report-cleanup] Found ${expired.length} expired artifact(s) older than ${RETENTION_DAYS} days`);

    // Delete files from disk
    const deletedDirs = new Set<string>();
    for (const artifact of expired) {
      try {
        await fs.unlink(artifact.file_path);
        deletedFiles++;
        deletedDirs.add(path.dirname(artifact.file_path));
      } catch (err) {
        // File may already be missing — not a critical error
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`Failed to delete ${artifact.file_path}: ${err}`);
        }
      }
    }

    // Clean up empty execution directories
    for (const dir of deletedDirs) {
      try {
        const entries = await fs.readdir(dir);
        if (entries.length === 0) {
          await fs.rmdir(dir);
          // Also try the parent (definition-level dir)
          const parentDir = path.dirname(dir);
          const parentEntries = await fs.readdir(parentDir);
          if (parentEntries.length === 0) {
            await fs.rmdir(parentDir);
          }
        }
      } catch {
        // Non-critical — directory cleanup is best-effort
      }
    }

    // Delete DB records
    const expiredIds = expired.map((a: any) => a.id);
    const batchSize = 500;
    for (let i = 0; i < expiredIds.length; i += batchSize) {
      const batch = expiredIds.slice(i, i + batchSize);
      await (db as any).deleteFrom("generated_report_artifacts").where("id", "in", batch).execute();
      deletedRecords += batch.length;
    }

    getLogger("report").note("debug", `[report-cleanup] Deleted ${deletedFiles} file(s), ${deletedRecords} record(s), ${errors.length} error(s)`);
  } catch (err) {
    errors.push(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    getLogger("report").note("error", "[report-cleanup]", { detail: [errors[errors.length - 1]] });
  }

  return { deletedFiles, deletedRecords, errors };
}
