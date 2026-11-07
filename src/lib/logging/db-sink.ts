/**
 * Where warnings and errors go so the System Logs screen can show them.
 *
 * stdout is the log; this table is a convenience for the screen an
 * administrator opens when something is wrong. So it keeps only what an
 * administrator needs — `warn` and above by default (`LOG_DB_LEVEL`) — and it
 * is built to lose entries rather than hurt the application:
 *
 *   - a bounded buffer. When the database is down the oldest entries are
 *     dropped, and the number dropped is itself logged, instead of the queue
 *     growing until the process runs out of memory;
 *   - one multi-row INSERT per flush, not one statement per line;
 *   - no `process.exit`. Shutdown is the server's business; `flushLogs()` is
 *     what it calls.
 */

import { generateId } from "@/lib/utils";
import { LEVELS, type LogLevel } from "./log-spec";

export const SINK_CAPACITY = 1000;
const FLUSH_EVERY_MS = 2000;
const BATCH = 200;

export interface SinkEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  component: string;
  userId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  errorStack?: string | null;
}

let buffer: SinkEntry[] = [];
let dropped = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
let reportDrop: ((dropped: number, reason: string) => void) | null = null;

/** The lowest level written to the table. `LOG_DB_LEVEL=silent` turns it off. */
export function sinkLevel(env: NodeJS.ProcessEnv = process.env): LogLevel | "silent" {
  const declared = env.LOG_DB_LEVEL;
  if (declared === "silent") return "silent";
  return declared && declared in LEVELS ? (declared as LogLevel) : "warn";
}

export function wantsSink(level: LogLevel, env: NodeJS.ProcessEnv = process.env): boolean {
  const floor = sinkLevel(env);
  return floor !== "silent" && LEVELS[level] >= LEVELS[floor];
}

export function enqueue(entry: SinkEntry): void {
  if (typeof window !== "undefined") return;
  buffer.push(entry);
  if (buffer.length > SINK_CAPACITY) {
    const over = buffer.length - SINK_CAPACITY;
    buffer.splice(0, over);
    dropped += over;
  }
  start();
}

function start(): void {
  if (timer) return;
  timer = setInterval(() => void flushLogs(), FLUSH_EVERY_MS);
  // Never be the reason a process stays alive.
  timer.unref?.();
}

/** How many entries are waiting. For tests. */
export function pending(): number {
  return buffer.length;
}

/** Let the logger report drops without this module importing it (it imports us). */
export function onDrop(report: (dropped: number, reason: string) => void): void {
  reportDrop = report;
}

export function flushLogs(): Promise<void> {
  if (flushing) return flushing;
  if (buffer.length === 0 && dropped === 0) return Promise.resolve();

  flushing = (async () => {
    const batch = buffer.splice(0, BATCH);
    if (dropped > 0) {
      const count = dropped;
      dropped = 0;
      reportDrop?.(count, "the buffer was full");
    }
    if (batch.length === 0) return;

    try {
      const { getDb } = await import("@/lib/db/config");
      const rows = batch.map((entry) => ({
        id: generateId(),
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        component: entry.component,
        user_id: (entry.userId ?? null) as any,
        session_id: null,
        metadata: entry.metadata ? safeJson(entry.metadata) : null,
        error_stack: entry.errorStack ?? null,
        request_id: entry.requestId ?? null,
        message_vector: null,
      }));
      await getDb().insertInto("logs").values(rows).execute();
    } catch (err) {
      // Not re-queued: a database that cannot take these will not take them on
      // the next attempt either, and the buffer is bounded for exactly this.
      reportDrop?.(batch.length, err instanceof Error ? err.message.slice(0, 200) : "write failed");
    }
  })().finally(() => {
    flushing = null;
  });

  return flushing;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === "function" || typeof v === "symbol" ? undefined : v
    );
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetSinkForTesting(): void {
  buffer = [];
  dropped = 0;
  flushing = null;
  reportDrop = null;
  if (timer) clearInterval(timer);
  timer = null;
}

