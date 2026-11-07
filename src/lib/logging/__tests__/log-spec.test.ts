import { describe, expect, it } from "bun:test";
import {
  CHANNELS,
  ERROR_CATEGORIES,
  ERRORS,
  EVENTS,
  LEVELS,
  REDACT_KEYS,
} from "../log-spec";

/** The twelve categories every product shares, with the level each logs at. */
const SHARED_CATEGORIES: Record<string, string> = {
  validation: "warn",
  authentication: "warn",
  authorization: "warn",
  not_found: "info",
  conflict: "info",
  business_rule: "info",
  workflow: "warn",
  rate_limit: "warn",
  integration: "error",
  database: "error",
  configuration: "error",
  internal: "error",
};

describe("the error categories", () => {
  it("are the twelve the generated application declares, at the same levels", () => {
    const here = Object.fromEntries(
      Object.entries(ERROR_CATEGORIES).map(([name, c]) => [name, c.level])
    );
    expect(here as Record<string, string>).toEqual(SHARED_CATEGORIES);
  });

  it("never log a caller's mistake at error, or a server failure below it", () => {
    for (const [name, category] of Object.entries(ERROR_CATEGORIES)) {
      const statuses = category.statuses as readonly number[];
      if (statuses.every((s) => s < 500)) expect(["warn", "info"]).toContain(category.level);
      if (statuses.every((s) => s >= 500)) expect(["error", "fatal"]).toContain(category.level);
      expect(name).toBeTruthy();
    }
  });
});

describe("the error codes", () => {
  it("each answer a status the category allows", () => {
    for (const [code, error] of Object.entries(ERRORS)) {
      const allowed = ERROR_CATEGORIES[error.category].statuses as readonly number[];
      expect(allowed.includes(error.status), `${code} answers ${error.status}`).toBe(true);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("keep the codes the routes and the front end already use", () => {
    for (const code of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "INVALID_INPUT",
      "VALIDATION_ERROR",
      "SERVER_ERROR",
      "RATE_LIMITED",
      "EXECUTION_ERROR",
      "QUERY_NOT_FOUND",
    ]) {
      expect(Object.hasOwn(ERRORS, code), code).toBe(true);
    }
  });

  it("put a failed session lookup in the database category, never authentication", () => {
    expect(ERRORS.SESSION_UNAVAILABLE.category).toBe("database");
    expect(ERRORS.SESSION_UNAVAILABLE.status).toBe(503);
  });
});

describe("the events", () => {
  it("sit on a declared channel and are never quieter than it allows", () => {
    for (const [id, event] of Object.entries(EVENTS)) {
      expect(Object.hasOwn(CHANNELS, event.channel), id).toBe(true);
      expect(event.message.length).toBeGreaterThan(0);
      // A channel must be at least as verbose as its least severe event, or the
      // channel would silence an event it declares.
      expect(LEVELS[CHANNELS[event.channel]]).toBeLessThanOrEqual(LEVELS[event.level]);
    }
  });
});

describe("redaction", () => {
  it("covers credentials and this platform's connection secrets", () => {
    for (const key of ["password", "token", "secret", "authorization", "cookie"]) {
      expect(REDACT_KEYS as readonly string[]).toContain(key);
    }
    for (const key of ["connection_config", "connectionString", "ENCRYPTION_KEY", "AUTH_SECRET"]) {
      expect(REDACT_KEYS as readonly string[]).toContain(key);
    }
  });
});
