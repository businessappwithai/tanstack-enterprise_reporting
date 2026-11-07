import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as api from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { enableForTesting, inSpan, resetTracingForTesting, startServerSpan, tracingEnabled } from "../tracing";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";

beforeAll(() => {
  provider.register();
  enableForTesting(api);
});

afterAll(async () => {
  resetTracingForTesting();
  await provider.shutdown();
});

describe("tracingEnabled", () => {
  it("is off until a collector is named, and off when the SDK is disabled", () => {
    expect(tracingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " } as NodeJS.ProcessEnv)).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("a server span", () => {
  it("continues the caller's trace when the request carries a traceparent", () => {
    exporter.reset();
    const span = startServerSpan("GET /api/x", { "http.route": "/api/x" }, new Headers({ traceparent: `00-${TRACE}-${PARENT}-01` }));
    expect(span?.traceId).toBe(TRACE);
    span?.end({ status: 200 });

    const [finished] = exporter.getFinishedSpans();
    expect(finished?.spanContext().traceId).toBe(TRACE);
    expect(finished?.parentSpanId).toBe(PARENT);
    expect(finished?.attributes["http.route"]).toBe("/api/x");
    expect(finished?.attributes["http.response.status_code"]).toBe(200);
  });

  it("starts a new trace when it does not, and hands out its own ids for the log lines", () => {
    exporter.reset();
    const span = startServerSpan("GET /api/y", {}, new Headers());
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    span?.end({ status: 200 });
    expect(exporter.getFinishedSpans()[0]?.spanContext().spanId).toBe(span!.spanId);
  });

  it("marks a 5xx as an error and records the exception, and a 4xx as not", () => {
    exporter.reset();
    startServerSpan("GET /a", {}, new Headers())?.end({ status: 500, err: new Error("boom") });
    startServerSpan("GET /b", {}, new Headers())?.end({ status: 404 });
    const [failed, refused] = exporter.getFinishedSpans();
    expect(failed?.status.code).toBe(api.SpanStatusCode.ERROR);
    expect(failed?.events.some((event) => event.name === "exception")).toBe(true);
    expect(refused?.status.code).not.toBe(api.SpanStatusCode.ERROR);
  });

  it("makes spans started inside it its children", async () => {
    exporter.reset();
    const span = startServerSpan("GET /c", {}, new Headers())!;
    await span.run(() => inSpan("db query", async () => 1));
    span.end({ status: 200 });
    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === "db query");
    const parent = spans.find((s) => s.name === "GET /c");
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
    expect(child?.parentSpanId).toBe(parent?.spanContext().spanId);
  });
});

describe("when tracing is off", () => {
  it("returns no span and runs inSpan's work as a plain call", async () => {
    resetTracingForTesting();
    expect(startServerSpan("GET /z", {}, new Headers())).toBeNull();
    expect(await inSpan("work", async () => 42)).toBe(42);
    enableForTesting(api);
  });
});
