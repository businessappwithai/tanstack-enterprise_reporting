/**
 * Distributed tracing, off until a collector is named.
 *
 * Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://otel-collector:4318`) and each API
 * request becomes a server span, exported over OTLP/HTTP to that collector. Unset, none of this
 * runs and nothing in the OpenTelemetry packages is loaded.
 *
 * What it does and does not do:
 *   - the span continues the caller's trace when the request carries a W3C `traceparent`, and
 *     starts a new one otherwise;
 *   - the span's own trace and span ids are the ones written on every log line of the request,
 *     so a trace in Jaeger and the log lines that belong to it are found by the same id;
 *   - a 5xx marks the span as an error and records the exception;
 *   - there is no automatic instrumentation of the database or of outgoing calls. Wrap work
 *     worth seeing in `inSpan("name", fn)`.
 *
 * Server only, and imported only by server code: the OpenTelemetry packages are loaded with
 * dynamic `import()` so a page that renders in a browser never carries them.
 */

import { onShutdown } from "@/lib/logging/shutdown";

type Api = typeof import("@opentelemetry/api");

let api: Api | undefined;
let starting: Promise<void> | undefined;

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) && env.OTEL_SDK_DISABLED !== "true";
}

/** Start the exporter once. Resolves whether or not it could start; failure is logged, not thrown. */
export function initTracing(): Promise<void> {
  if (!tracingEnabled()) return Promise.resolve();
  starting ??= (async () => {
    try {
      const [apiModule, nodeSdk, baseSdk, exporter, resources, conventions] = await Promise.all([
        import("@opentelemetry/api"),
        import("@opentelemetry/sdk-trace-node"),
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/resources"),
        import("@opentelemetry/semantic-conventions"),
      ]);

      const provider = new nodeSdk.NodeTracerProvider({
        resource: new resources.Resource({
          [conventions.ATTR_SERVICE_NAME]:
            process.env.OTEL_SERVICE_NAME ?? process.env.LOG_NAME ?? "enterprise-reporting",
        }),
        spanProcessors: [new baseSdk.BatchSpanProcessor(new exporter.OTLPTraceExporter())],
      });
      // Registers the global provider, the async context manager and the W3C propagator.
      provider.register();
      onShutdown(() => provider.shutdown());
      api = apiModule;
    } catch (err) {
      // Imported lazily so the logger is not a dependency of this module's load.
      const { getLogger } = await import("@/lib/logging/logger");
      getLogger("app").event("telemetry.start_failed", { err });
    }
  })();
  return starting;
}

export interface ServerSpan {
  traceId: string;
  spanId: string;
  /** Run `fn` with this span active, so spans started inside it are its children. */
  run<T>(fn: () => T): T;
  end(result: { status: number; err?: unknown }): void;
}

/** A server span for one request, or null when tracing is off or could not start. */
export function startServerSpan(
  name: string,
  attributes: Record<string, string | number>,
  headers: Headers
): ServerSpan | null {
  if (!api) return null;
  const { context, propagation, trace, SpanKind, SpanStatusCode, ROOT_CONTEXT } = api;

  const carrier: Record<string, string> = {};
  headers.forEach((value, key) => {
    carrier[key] = value;
  });
  const parent = propagation.extract(ROOT_CONTEXT, carrier);
  const span = trace.getTracer("enterprise-reporting").startSpan(
    name,
    { kind: SpanKind.SERVER, attributes },
    parent
  );
  const active = trace.setSpan(parent, span);
  const ids = span.spanContext();

  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    run: (fn) => context.with(active, fn),
    end({ status, err }) {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (err instanceof Error) span.recordException(err);
      }
      span.end();
    },
  };
}

/** Time a piece of work as a child of the current request's span. A plain call when tracing is off. */
export async function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!api) return fn();
  const tracer = api.trace.getTracer("enterprise-reporting");
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.setStatus({ code: api!.SpanStatusCode.ERROR });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Test seam: use a given API module (with a provider already registered) instead of starting one. */
export function enableForTesting(apiModule: Api): void {
  api = apiModule;
}

/** Test seam. */
export function resetTracingForTesting(): void {
  api = undefined;
  starting = undefined;
}
