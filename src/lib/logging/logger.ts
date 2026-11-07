/**
 * Logging for the platform: Pino, configured from `log-spec.ts`.
 *
 *     const log = getLogger("sql");
 *     log.event("sql.query.executed", { dataSourceId, rowCount, durationMs, userId });
 *
 * A call site names an event; the level and the wording come from the spec, so
 * what the platform logs is changed in one file. Output is newline-delimited
 * JSON on stdout (pretty-printed in development), with the fields in
 * `REDACT_KEYS` censored by name. Warnings and errors are also queued for the
 * `logs` table the System Logs screen reads — see `db-sink.ts`.
 *
 * Two environment variables an operator will want:
 *
 *   LOG_LEVEL=debug           every channel, louder
 *   LOG_LEVEL_SQL=debug       one channel, louder, leaving the rest alone
 *
 * `createLogger({ component })` is the older, free-text interface. It still
 * works so existing call sites keep running, but it is deprecated: a line
 * written through it has no event id, and the next sweep replaces it.
 */

import pino, { type Logger as PinoLogger } from "pino";
import { enqueue, flushLogs, onDrop, wantsSink } from "./db-sink";
import {
  CHANNELS,
  type Channel,
  type ConfiguredLevel,
  ENVIRONMENTS,
  EVENTS,
  type EventId,
  LEVELS,
  type LogLevel,
  REDACT_CENSOR,
  REDACT_KEYS,
} from "./log-spec";
import { currentRequestContext } from "./request-context";

export type LogFields = Record<string, unknown>;

export interface ChannelLogger {
  readonly channel: string;
  readonly level: ConfiguredLevel;
  event(id: EventId, fields?: LogFields): void;
  child(bindings: LogFields): ChannelLogger;
}

/* -------------------------------------------------------------------------- */
/*  Levels                                                                     */
/* -------------------------------------------------------------------------- */

const isConfigured = (value: unknown): value is ConfiguredLevel =>
  value === "silent" || (typeof value === "string" && value in LEVELS);

function profileFor(env: string | undefined) {
  const named = env ? ENVIRONMENTS[env] : undefined;
  // An unrecognised environment gets production's profile, not development's:
  // guessing wrong that way only costs verbosity, the other way leaks it.
  return named ?? (ENVIRONMENTS.production as { level: ConfiguredLevel; pretty: boolean });
}

const rank = (level: ConfiguredLevel): number =>
  level === "silent" ? Number.POSITIVE_INFINITY : LEVELS[level];

/**
 * The level a channel logs at. `LOG_LEVEL_<CHANNEL>`, then `LOG_LEVEL`, then the
 * quieter of the environment's level and the channel's own.
 */
export function resolveLevel(channel: string, env: NodeJS.ProcessEnv = process.env): ConfiguredLevel {
  const perChannel = env[`LOG_LEVEL_${channel.toUpperCase()}`];
  if (isConfigured(perChannel)) return perChannel;
  const global = env.LOG_LEVEL;
  if (isConfigured(global)) return global;

  const profile = profileFor(env.NODE_ENV);
  if (profile.level === "silent") return "silent";
  const declared = (CHANNELS as Record<string, LogLevel>)[channel];
  if (!declared) return profile.level;
  return rank(declared) < rank(profile.level) ? profile.level : declared;
}

/* -------------------------------------------------------------------------- */
/*  Redaction (for what bypasses Pino: the database sink)                      */
/* -------------------------------------------------------------------------- */

const REDACT_SET = new Set(REDACT_KEYS.map((key) => key.toLowerCase()));

export function redactFields(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > 5) return "[…]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactFields(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_SET.has(key.toLowerCase()) ? REDACT_CENSOR : redactFields(inner, depth + 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The root logger                                                            */
/* -------------------------------------------------------------------------- */

let root: PinoLogger | undefined;
const startedAt = Date.now();

function getRoot(): PinoLogger {
  if (root) return root;

  const profile = profileFor(process.env.NODE_ENV);
  const pretty =
    process.env.LOG_PRETTY === "true" ? true : process.env.LOG_PRETTY === "false" ? false : profile.pretty;

  const options = {
    // The root sits at `trace` and each channel clamps itself above it; a root at
    // the environment's level would drop what LOG_LEVEL_<CHANNEL> asked to see.
    level: "trace",
    base: { service: process.env.LOG_NAME ?? "enterprise-reporting" },
    redact: { paths: [...REDACT_KEYS, ...REDACT_KEYS.map((k) => `*.${k}`)], censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };

  root = pretty
    ? pino({
        ...options,
        transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
      })
    : pino(options, pino.destination({ dest: 1, sync: process.env.NODE_ENV === "test" || process.env.LOG_SYNC === "true" }));

  installProcessLogging();
  return root;
}

function toStack(value: unknown): string | null {
  const err = value instanceof Error ? value : (value as { stack?: unknown } | null)?.stack ? (value as Error) : null;
  return err?.stack ?? null;
}

function wrap(pinoLogger: PinoLogger, channel: string, level: ConfiguredLevel): ChannelLogger {
  return {
    channel,
    level,
    event(id, fields = {}) {
      const declared = (EVENTS as Record<string, { channel: string; level: LogLevel; message: string; fields: readonly string[] }>)[id];
      if (!declared) {
        // An id the spec does not declare is a bug in the caller, and the one thing
        // it must not do is vanish.
        pinoLogger.warn({ ...fields, event: id, logSpecViolation: "unknown-event-id" }, `Log event "${id}" is not declared`);
        return;
      }

      const context = currentRequestContext();
      const merged: LogFields = {
        ...(context ? { requestId: context.requestId, userId: context.userId ?? null } : {}),
        ...fields,
      };
      const missing = declared.fields.filter((field) => merged[field] === undefined);
      const payload: LogFields = { ...merged, event: id };
      if (missing.length > 0) payload.logSpecMissingFields = missing;

      // Pino's `err` serializer takes an Error; anything else is stringified so a
      // thrown string or object still leaves a trace.
      if ("err" in payload && payload.err && !(payload.err instanceof Error)) {
        payload.err = new Error(typeof payload.err === "string" ? payload.err : JSON.stringify(redactFields(payload.err)));
      }

      if (rank(level) <= LEVELS[declared.level]) pinoLogger[declared.level](payload, declared.message);

      if (wantsSink(declared.level) && rank(level) <= LEVELS[declared.level]) {
        const { err, requestId, userId, ...rest } = payload as LogFields & { err?: unknown };
        enqueue({
          timestamp: new Date().toISOString(),
          level: declared.level,
          message: declared.message,
          component: channel,
          userId: (userId as string | null | undefined) ?? null,
          requestId: (requestId as string | null | undefined) ?? null,
          metadata: redactFields({ ...rest, event: id }) as Record<string, unknown>,
          errorStack: toStack(err),
        });
      }
    },
    child(bindings) {
      return wrap(pinoLogger.child(bindings), channel, level);
    },
  };
}

const cache = new Map<string, ChannelLogger>();

export function getLogger(channel: Channel): ChannelLogger {
  const cached = cache.get(channel);
  if (cached) return cached;
  const level = resolveLevel(channel);
  const logger = wrap(getRoot().child({ channel }, { level: level === "silent" ? "silent" : level }), channel, level);
  cache.set(channel, logger);
  return logger;
}

onDrop((dropped, reason) => {
  // Written to stdout only: it must not re-enter the sink it is reporting on.
  getRoot().warn({ event: "logging.sink.dropped", channel: "logging", dropped, reason }, EVENTS["logging.sink.dropped"].message);
});

/* -------------------------------------------------------------------------- */
/*  Process lifecycle                                                          */
/* -------------------------------------------------------------------------- */

let processInstalled = false;

/**
 * Record what otherwise leaves no trace: an exception nobody caught, a promise
 * rejected with no handler, and the signal that stops the process.
 *
 * An uncaught exception is fatal; the line is flushed before anything else. An
 * unhandled rejection is almost always one request's side effect, so it is
 * logged at `error` and the process keeps serving. On SIGTERM/SIGINT the logs
 * are flushed, and the process exits only if nothing else is handling the
 * signal — the server's own graceful shutdown comes first.
 */
export function installProcessLogging(): void {
  if (processInstalled || typeof process === "undefined" || typeof process.on !== "function") return;
  processInstalled = true;

  process.on("uncaughtException", (err) => {
    getRoot().fatal({ event: "app.uncaught", channel: "app", err }, EVENTS["app.uncaught"].message);
    void flushLogs().finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    getRoot().error({ event: "app.unhandled_rejection", channel: "app", err: reason instanceof Error ? reason : new Error(String(reason)) }, EVENTS["app.unhandled_rejection"].message);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      getRoot().info({ event: "app.shutdown", channel: "app", signal, uptimeMs: Date.now() - startedAt }, EVENTS["app.shutdown"].message);
      void flushLogs().finally(() => {
        if (process.listenerCount(signal) <= 1) process.exit(0);
      });
    });
  }
}

export async function flushAllLogs(): Promise<void> {
  await flushLogs();
}

/** The raw Pino root, for code that needs to hand a logger to a library. */
export function getCloudLogger(): PinoLogger {
  return getRoot();
}

/* -------------------------------------------------------------------------- */
/*  The older interface                                                        */
/* -------------------------------------------------------------------------- */

let legacy: PinoLogger | undefined;
const legacyOut = (): PinoLogger => (legacy ??= getRoot().child({ channel: "app" }));

export interface LogContext {
  userId?: string;
  sessionId?: string;
  requestId?: string;
  component: string;
}

/**
 * @deprecated Free text: no event id, no spec. Kept so existing call sites run
 * until they are moved to `getLogger(channel).event(...)`. Warnings and errors
 * still reach the System Logs table, now redacted and bounded.
 */
export function createLogger(context: LogContext) {
  const write = (level: LogLevel, message: string, metadata?: Record<string, unknown>, error?: Error) => {
    // The channel's level governs this interface too: a silent environment (the test
    // run) writes nothing to stdout and nothing to the database table.
    if (rank(resolveLevel("app")) > LEVELS[level]) return;

    const requestContext = currentRequestContext();
    const safe = metadata ? (redactFields(metadata) as Record<string, unknown>) : undefined;
    const userId = context.userId ?? requestContext?.userId ?? null;
    const requestId = context.requestId ?? requestContext?.requestId ?? null;

    legacyOut()[level]({ component: context.component, userId, requestId, ...safe, ...(error ? { err: error } : {}) }, message);

    if (wantsSink(level)) {
      enqueue({
        timestamp: new Date().toISOString(),
        level,
        message,
        component: context.component,
        userId,
        requestId,
        metadata: safe,
        errorStack: error?.stack ?? null,
      });
    }
  };

  return {
    info: (message: string, metadata?: Record<string, unknown>) => write("info", message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) => write("warn", message, metadata),
    error: (message: string, error?: Error, metadata?: Record<string, unknown>) => write("error", message, metadata, error),
    debug: (message: string, metadata?: Record<string, unknown>) => write("debug", message, metadata),
  };
}

/** Test seam: forget the root and every channel logger. */
export function resetLoggerForTesting(): void {
  root = undefined;
  legacy = undefined;
  cache.clear();
  processInstalled = false;
}
