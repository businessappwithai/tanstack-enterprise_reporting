import { afterEach, describe, expect, it } from "bun:test";
import {
  getChannelLevels,
  getLogger,
  isChannel,
  isSettableLevel,
  resetChannelLevel,
  resetLoggerForTesting,
  setChannelLevel,
} from "../logger";
import { keepDebug, parseTraceparent, sampleRate } from "../trace-context";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("reads a well-formed header and ignores everything else", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
    for (const bad of [
      undefined,
      null,
      "",
      `ff-${TRACE}-${SPAN}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
      `00-${TRACE}-${SPAN}-01\nX: 1`,
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
  });
});

describe("debug sampling", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

  it("keeps everything unless told otherwise, and clamps", () => {
    expect(sampleRate(undefined)).toBe(1);
    expect(sampleRate("nonsense")).toBe(1);
    expect(sampleRate("7")).toBe(1);
    expect(sampleRate("-2")).toBe(0);
  });

  it("gives a request one answer and keeps about the requested share", () => {
    for (const id of ids.slice(0, 30)) expect(keepDebug(id, 0.3)).toBe(keepDebug(id, 0.3));
    const share = ids.filter((id) => keepDebug(id, 0.25)).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    expect(keepDebug(ids[0], 1)).toBe(true);
    expect(keepDebug(ids[0], 0)).toBe(false);
  });
});

describe("changing a level while running", () => {
  afterEach(() => {
    resetLoggerForTesting();
  });

  it("lists every channel with its declared level and no overrides", () => {
    const levels = getChannelLevels();
    expect(levels.length).toBeGreaterThan(5);
    expect(levels.every((row) => row.overridden === false)).toBe(true);
    expect(levels.find((row) => row.channel === "sql")?.declared).toBe("debug");
  });

  it("sets a level, reports it, and resets to what the environment says", () => {
    const set = setChannelLevel("sql", "trace");
    expect(set.to).toBe("trace");
    expect(getLogger("sql").level).toBe("trace");
    expect(getChannelLevels().find((row) => row.channel === "sql")).toMatchObject({
      effective: "trace",
      overridden: true,
    });

    const reset = resetChannelLevel("sql");
    expect(reset.from).toBe("trace");
    expect(getChannelLevels().find((row) => row.channel === "sql")?.overridden).toBe(false);
  });

  it("knows a channel from a stranger and a level from a word", () => {
    expect(isChannel("sql")).toBe(true);
    expect(isChannel("no_such_channel")).toBe(false);
    expect(isChannel("__proto__")).toBe(false);
    for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) {
      expect(isSettableLevel(level)).toBe(true);
    }
    for (const level of ["DEBUG", "loud", "", null, 3]) expect(isSettableLevel(level)).toBe(false);
  });
});
