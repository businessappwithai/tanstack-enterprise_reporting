import { afterEach, describe, expect, it } from "bun:test";
import { enqueue, pending, resetSinkForTesting, SINK_CAPACITY, sinkLevel, wantsSink } from "../db-sink";
import { redactFields, resolveLevel } from "../logger";
import { acceptRequestId, currentRequestContext, runWithRequestContext, setRequestContext } from "../request-context";

describe("resolveLevel", () => {
  it("lets a channel override beat the global one, and both beat the environment", () => {
    const env = { NODE_ENV: "production", LOG_LEVEL: "warn", LOG_LEVEL_SQL: "debug" } as NodeJS.ProcessEnv;
    expect(resolveLevel("sql", env)).toBe("debug");
    expect(resolveLevel("http", env)).toBe("warn");
  });

  it("is silent in the test environment and in production info otherwise", () => {
    expect(resolveLevel("sql", { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("silent");
    expect(resolveLevel("sql", { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("info");
  });

  it("treats an unknown environment as production, not development", () => {
    expect(resolveLevel("sql", { NODE_ENV: "qa-box" } as NodeJS.ProcessEnv)).toBe("info");
  });

  it("ignores a level that is not one", () => {
    expect(resolveLevel("sql", { NODE_ENV: "production", LOG_LEVEL: "loud" } as NodeJS.ProcessEnv)).toBe("info");
  });
});

describe("redactFields", () => {
  it("censors credentials and connection secrets by key name, at any depth", () => {
    const printed = JSON.stringify(
      redactFields({
        user: "jane",
        password: "hunter2",
        nested: { Authorization: "Bearer abc", connection_config: "enc:xyz", ok: 1 },
        list: [{ apiKey: "k-1" }],
      })
    );
    for (const secret of ["hunter2", "Bearer abc", "enc:xyz", "k-1"]) expect(printed).not.toContain(secret);
    expect(printed).toContain("jane");
  });

  it("prints an Error as its name and message, not its stack", () => {
    expect(redactFields(new TypeError("bad"))).toEqual({ name: "TypeError", message: "bad" });
  });
});

describe("the database sink", () => {
  afterEach(resetSinkForTesting);

  it("takes warnings and errors by default, and nothing quieter", () => {
    expect(sinkLevel({} as NodeJS.ProcessEnv)).toBe("warn");
    expect(wantsSink("warn", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(wantsSink("error", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(wantsSink("info", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(wantsSink("error", { LOG_DB_LEVEL: "silent" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is bounded: a database that is down cannot grow the queue without limit", () => {
    // `window` is undefined under bun, so enqueue accepts the entries.
    for (let i = 0; i < SINK_CAPACITY + 250; i++) {
      enqueue({ timestamp: new Date().toISOString(), level: "warn", message: `m${i}`, component: "t" });
    }
    expect(pending()).toBe(SINK_CAPACITY);
  });
});

describe("the request context", () => {
  it("carries the request id and user through everything a request awaits", async () => {
    await runWithRequestContext({ requestId: "req-12345678", userId: null }, async () => {
      await Promise.resolve();
      setRequestContext({ userId: "u1" });
      await new Promise((r) => setTimeout(r, 1));
      expect(currentRequestContext()).toEqual({ requestId: "req-12345678", userId: "u1" });
    });
    expect(currentRequestContext()).toBeUndefined();
  });

  it("accepts a plain caller-supplied id and replaces one that could forge a log line", () => {
    expect(acceptRequestId("client-req-0001")).toBe("client-req-0001");
    for (const hostile of ["x y", "a\nb", "short", "x".repeat(65), '{"level":"fatal"}']) {
      expect(acceptRequestId(hostile)).not.toBe(hostile);
    }
    expect(acceptRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
