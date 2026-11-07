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
import { keepDebug, sampleRate } from "./trace-context";

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

/**
 * The environment, wherever this runs. A page imports the logger on both sides, and `process`
 * does not exist in a browser: there the build mode stands in for NODE_ENV and
 * `VITE_LOG_LEVEL` for LOG_LEVEL.
 */
function runtimeEnv(): NodeJS.ProcessEnv {
  if (typeof process !== "undefined" && process.env) return process.env;
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return { NODE_ENV: meta.MODE, LOG_LEVEL: meta.VITE_LOG_LEVEL } as NodeJS.ProcessEnv;
}

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
export function resolveLevel(channel: string, env: NodeJS.ProcessEnv = runtimeEnv()): ConfiguredLevel {
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

  const env = runtimeEnv();

  // In a browser: Pino's browser build, writing objects to the console. Warnings and errors
  // are also sent to the server's bounded `/api/logs` so the System Logs screen sees them;
  // see `transmitToServer`.
  if (typeof window !== "undefined") {
    root = pino({
      level: "trace",
      redact: { paths: [...REDACT_KEYS, ...REDACT_KEYS.map((k) => `*.${k}`)], censor: REDACT_CENSOR },
      browser: { asObject: true, transmit: { level: "warn", send: transmitToServer } },
    });
    return root;
  }

  const profile = profileFor(env.NODE_ENV);
  const pretty = env.LOG_PRETTY === "true" ? true : env.LOG_PRETTY === "false" ? false : profile.pretty;

  const options = {
    // The root sits at `trace` and each channel clamps itself above it; a root at
    // the environment's level would drop what LOG_LEVEL_<CHANNEL> asked to see.
    level: "trace",
    base: { service: env.LOG_NAME ?? "enterprise-reporting" },
    redact: { paths: [...REDACT_KEYS, ...REDACT_KEYS.map((k) => `*.${k}`)], censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };

  root = pretty
    ? pino({
        ...options,
        transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
      })
    : pino(options, pino.destination({ dest: 1, sync: env.NODE_ENV === "test" || env.LOG_SYNC === "true" }));

  installProcessLogging();
  return root;
}

/* -------------------------------------------------------------------------- */
/*  The browser reports to the server                                          */
/* -------------------------------------------------------------------------- */

const CLIENT_WINDOW_MS = 60_000;
const CLIENT_MAX_PER_WINDOW = 20;
let clientWindowStart = 0;
let clientSent = 0;
const clientRecent = new Map<string, number>();

/**
 * Pino's browser `transmit` hook: send a warning or error to `POST /api/logs`, the bounded route
 * the System Logs screen reads. Fire and forget, never throws, never retries (a reporter that
 * retries against a dead server is a loop), at most twenty a minute, and the same message at
 * most once a minute — a component that fails on every render would otherwise post every frame.
 */
function transmitToServer(
  level: string,
  event: { messages: unknown[]; bindings: Array<Record<string, unknown>> }
): void {
  try {
    if (typeof fetch === "undefined") return;
    const now = Date.now();
    const first = event.messages[0];
    const message =
      (typeof first === "string" ? first : (first as { msg?: string; what?: string } | undefined)?.what ??
        (first as { msg?: string } | undefined)?.msg ?? "") || String(event.messages[1] ?? "");
    if (!message) return;
    const key = `${level}|${message}`;
    const last = clientRecent.get(key);
    if (last !== undefined && now - last < CLIENT_WINDOW_MS) return;
    if (now - clientWindowStart >= CLIENT_WINDOW_MS) {
      clientWindowStart = now;
      clientSent = 0;
    }
    if (clientSent >= CLIENT_MAX_PER_WINDOW) return;
    clientSent += 1;
    clientRecent.set(key, now);
    if (clientRecent.size > 200) clientRecent.clear();

    const stack = (first as { stack?: unknown } | undefined)?.stack;
    const channel = String(event.bindings.find((b) => typeof b?.channel === "string")?.channel ?? "client");
    void fetch("/api/logs", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: level === "fatal" ? "error" : level,
        message: message.slice(0, 4000),
        component: channel.replace(/[^\w.:/-]/g, "_").slice(0, 100) || "client",
        metadata: { page: typeof location !== "undefined" ? location.pathname : undefined },
        ...(typeof stack === "string" && { errorStack: stack.slice(0, 16 * 1024) }),
      }),
    }).catch(() => undefined);
  } catch {
    // The reporter failing must not be a second error.
  }
}

function toStack(value: unknown): string | null {
  const err = value instanceof Error ? value : (value as { stack?: unknown } | null)?.stack ? (value as Error) : null;
  return err?.stack ?? null;
}

/** Read once: the sampling rate does not change while the process runs. */
const DEBUG_SAMPLE_RATE = sampleRate(typeof process !== "undefined" ? process.env.LOG_SAMPLE_DEBUG : undefined);

/**
 * The active OpenTelemetry span's ids, when an SDK is registered and `@opentelemetry/api` is
 * installed. It is not a dependency of this platform: it is looked up once, only when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or `LOG_TRACE_IDS=true` is set, and its absence is not an error.
 */
let otelApi: { trace?: { getActiveSpan?: () => { spanContext?: () => { traceId?: string; spanId?: string } } | undefined } } | undefined;
let otelTried = false;

function activeTrace(): { traceId: string; spanId: string } | undefined {
  if (typeof process === "undefined") return undefined;
  if (!otelTried) {
    otelTried = true;
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.LOG_TRACE_IDS === "true") {
      try {
        otelApi = require("@opentelemetry/api");
      } catch {
        otelApi = undefined;
      }
    }
  }
  const ids = otelApi?.trace?.getActiveSpan?.()?.spanContext?.();
  if (!ids?.traceId || !ids.spanId || /^0+$/.test(ids.traceId)) return undefined;
  return { traceId: ids.traceId, spanId: ids.spanId };
}

function wrap(pinoLogger: PinoLogger, channel: string, initial: ConfiguredLevel): ChannelLogger {
  return {
    channel,
    // Read from the Pino child, so a level set through the admin route is what this reports.
    get level(): ConfiguredLevel {
      return (pinoLogger.level as ConfiguredLevel) ?? initial;
    },
    event(id, fields = {}) {
      const declared = (EVENTS as Record<string, { channel: string; level: LogLevel; message: string; fields: readonly string[] }>)[id];
      if (!declared) {
        // An id the spec does not declare is a bug in the caller, and the one thing
        // it must not do is vanish.
        pinoLogger.warn({ ...fields, event: id, logSpecViolation: "unknown-event-id" }, `Log event "${id}" is not declared`);
        return;
      }

      const context = currentRequestContext();
      const level = pinoLogger.level as ConfiguredLevel;

      // Debug and trace lines may be sampled (LOG_SAMPLE_DEBUG); a request is kept or dropped
      // whole. Anything at warn or above is never asked.
      if ((declared.level === "debug" || declared.level === "trace") && !keepDebug(context?.requestId, DEBUG_SAMPLE_RATE)) {
        return;
      }

      const trace = context?.traceId ? undefined : activeTrace();
      const merged: LogFields = {
        ...(context
          ? {
              requestId: context.requestId,
              userId: context.userId ?? null,
              ...(context.traceId && { traceId: context.traceId, spanId: context.spanId }),
            }
          : {}),
        ...(trace ?? {}),
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

      const message = declared.message;
      if (rank(level) <= LEVELS[declared.level]) pinoLogger[declared.level](payload, message);

      if (wantsSink(declared.level) && rank(level) <= LEVELS[declared.level]) {
        const { err, requestId, userId, ...rest } = payload as LogFields & { err?: unknown };
        enqueue({
          timestamp: new Date().toISOString(),
          level: declared.level,
          message,
          component: channel,
          userId: (userId as string | null | undefined) ?? null,
          requestId: (requestId as string | null | undefined) ?? null,
          metadata: redactFields({ ...rest, event: id }) as Record<string, unknown>,
          errorStack: toStack(err),
          category: typeof rest.errorCategory === "string" ? rest.errorCategory : null,
          code: typeof rest.errorCode === "string" ? rest.errorCode : null,
        });
      }
    },
    child(bindings) {
      return wrap(pinoLogger.child(bindings), channel, pinoLogger.level as ConfiguredLevel);
    },
  };
}

const cache = new Map<string, ChannelLogger>();

export function getLogger(channel: Channel): ChannelLogger {
  const cached = cache.get(channel);
  if (cached) return cached;
  const level = resolveLevel(channel);
  const child = getRoot().child({ channel }, { level: level === "silent" ? "silent" : level });
  channelChildren.set(channel, child);
  const logger = wrap(child, channel, level);
  cache.set(channel, logger);
  return logger;
}

/* -------------------------------------------------------------------------- */
/*  Changing a level while running                                             */
/* -------------------------------------------------------------------------- */

/** The Pino child behind each channel, so its level can be changed in place. */
const channelChildren = new Map<string, PinoLogger>();

/** Levels set through the admin route. In memory only: a restart returns to the configured ones. */
const overrides = new Map<string, string>();

export interface ChannelLevelReport {
  channel: string;
  declared: string;
  effective: string;
  overridden: boolean;
  /** True when the override is also stored in the database and so survives a restart. */
  persisted: boolean;
}

/** Channels whose override is also stored in the database. */
const persisted = new Set<string>();

export function markPersisted(channel: string, isPersisted: boolean): void {
  if (isPersisted) persisted.add(channel);
  else persisted.delete(channel);
}

export interface LevelChange {
  channel: string;
  from: string;
  to: string;
}

export function isChannel(name: string): name is Channel {
  return Object.hasOwn(CHANNELS, name);
}

export function isSettableLevel(value: unknown): value is ConfiguredLevel {
  return isConfigured(value);
}

/** Every channel the spec declares, its configured level and what it logs at now. */
export function getChannelLevels(): ChannelLevelReport[] {
  return (Object.keys(CHANNELS) as Channel[]).map((channel) => ({
    channel,
    declared: CHANNELS[channel],
    effective: String(getLogger(channel).level),
    overridden: overrides.has(channel),
    persisted: persisted.has(channel),
  }));
}

export function setChannelLevel(channel: Channel, level: ConfiguredLevel): LevelChange {
  const logger = getLogger(channel);
  const from = String(logger.level);
  const child = channelChildren.get(channel);
  if (child) child.level = level;
  overrides.set(channel, level);
  return { channel, from, to: level };
}

/**
 * Make the stored overrides the ones in force. A channel that was stored and no longer is goes
 * back to its configured level (another instance reset it); an override that was only ever in
 * memory is left alone.
 */
export function applyStoredLevels(rows: Array<{ channel: string; level: string }>): void {
  const stored = new Map<string, ConfiguredLevel>();
  for (const row of rows) {
    if (isChannel(row.channel) && isConfigured(row.level)) stored.set(row.channel, row.level);
  }
  for (const channel of [...persisted]) {
    if (!stored.has(channel) && isChannel(channel)) {
      resetChannelLevel(channel);
      persisted.delete(channel);
    }
  }
  for (const [channel, level] of stored) {
    if (!isChannel(channel)) continue;
    if (overrides.get(channel) !== level) setChannelLevel(channel as Channel, level);
    persisted.add(channel);
  }
}

/** Back to what the spec and the environment say. */
export function resetChannelLevel(channel: Channel): LevelChange {
  const logger = getLogger(channel);
  const from = String(logger.level);
  const configured = resolveLevel(channel);
  const child = channelChildren.get(channel);
  if (child) child.level = configured;
  overrides.delete(channel);
  return { channel, from, to: configured };
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
  if (typeof window !== "undefined") return;
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
  channelChildren.clear();
  overrides.clear();
  persisted.clear();
  processInstalled = false;
}
