/**
 * Where persisted log levels live, and the loop that applies them.
 *
 * Read when the database comes up and every thirty seconds after, so a restart keeps an
 * override and so does a second instance behind the same database. A table that cannot be read
 * never stops the platform: the levels stay as they are and one warning says so.
 */

import { sql, type Kysely } from "kysely";
import { applyStoredLevels, getLogger } from "./logger";

const REFRESH_MS = 30_000;

type Handle = Kysely<any>;

let timer: ReturnType<typeof setInterval> | undefined;
let reportedFailure = false;

async function refresh(db: Handle): Promise<void> {
  try {
    const result = await sql<{ channel: string; level: string }>`
      SELECT channel, level FROM log_level_overrides
    `.execute(db);
    reportedFailure = false;
    applyStoredLevels(result.rows);
  } catch (err) {
    if (!reportedFailure) {
      reportedFailure = true;
      getLogger("logging").event("logging.overrides.unavailable", { err });
    }
  }
}

/** Apply what the table says now, and keep applying it. Idempotent. */
export function startLevelSync(db: Handle): void {
  if (typeof window !== "undefined" || timer) return;
  void refresh(db);
  timer = setInterval(() => void refresh(db), REFRESH_MS);
  timer.unref?.();
}

/** Keep a level across restarts. False when it could not be stored. */
export async function saveLevel(db: Handle, channel: string, level: string, by: string): Promise<boolean> {
  try {
    await sql`
      INSERT INTO log_level_overrides (channel, level, updated_by, updated_at)
      VALUES (${channel}, ${level}, ${by}, ${new Date().toISOString()})
      ON CONFLICT (channel) DO UPDATE
        SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    `.execute(db);
    return true;
  } catch (err) {
    getLogger("logging").event("logging.overrides.unavailable", { err });
    return false;
  }
}

export async function removeLevel(db: Handle, channel: string): Promise<boolean> {
  try {
    await sql`DELETE FROM log_level_overrides WHERE channel = ${channel}`.execute(db);
    return true;
  } catch (err) {
    getLogger("logging").event("logging.overrides.unavailable", { err });
    return false;
  }
}

/** Test seam. */
export function stopLevelSyncForTesting(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  reportedFailure = false;
}
