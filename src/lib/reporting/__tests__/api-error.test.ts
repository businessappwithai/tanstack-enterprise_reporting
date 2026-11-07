import { describe, expect, test } from "bun:test";
import { ApiError, readApiError, retryUnlessRefused } from "../api-error";

const refusal = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readApiError", () => {
  test("a 403 names the tables the role may not read", async () => {
    const err = await readApiError(
      refusal(403, {
        success: false,
        error: { code: "FORBIDDEN", message: "You don't have permission to access: bus_household" },
      }),
      "Failed to load report data"
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("You don't have permission to access: bus_household");
  });

  test("a string error is read as the message", async () => {
    expect((await readApiError(refusal(400, { error: "bad input" }), "x")).message).toBe(
      "bad input"
    );
  });

  test("a body that is not JSON falls back to the status line", async () => {
    const err = await readApiError(new Response("<html>", { status: 502 }), "Failed to load");
    expect(err.message).toBe("Failed to load (HTTP 502)");
    expect(err.status).toBe(502);
  });
});

describe("retryUnlessRefused", () => {
  test("a refusal is not retried", () => {
    expect(retryUnlessRefused(0, new ApiError("no", 403))).toBe(false);
    expect(retryUnlessRefused(0, new ApiError("gone", 404))).toBe(false);
  });
  test("a server failure is retried twice", () => {
    expect(retryUnlessRefused(0, new ApiError("boom", 500))).toBe(true);
    expect(retryUnlessRefused(2, new ApiError("boom", 500))).toBe(false);
  });
  test("a network failure is retried", () => {
    expect(retryUnlessRefused(0, new TypeError("fetch failed"))).toBe(true);
  });
});
