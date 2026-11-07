import { describe, expect, it } from "bun:test";
import { appError } from "@/lib/errors/app-error";
import { json } from "@/lib/server/response";
import { currentRequestContext } from "@/lib/logging/request-context";
import { withApiHandler } from "../with-api-handler";

const call = (handler: (c: { request: Request }) => Promise<Response> | Response, headers: HeadersInit = {}) =>
  withApiHandler("/api/test", handler)({ request: new Request("http://x.test/api/test", { headers }) });

describe("withApiHandler", () => {
  it("passes a success through and stamps the request id", async () => {
    const response = await call(() => json({ success: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("opens a request context the handler can see", async () => {
    let seen: string | undefined;
    await call(() => {
      seen = currentRequestContext()?.requestId;
      return json({});
    }, { "x-request-id": "caller-req-0001" });
    expect(seen).toBe("caller-req-0001");
  });

  it("replaces a request id that could forge a log line", async () => {
    const response = await call(() => json({}), { "x-request-id": "a b" });
    expect(response.headers.get("x-request-id")).not.toBe("a b");
  });

  it("answers a thrown appError with the envelope, the code, the category and the ref", async () => {
    const response = await call(() => {
      throw appError("NOT_FOUND", { message: "Report not found" });
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", category: "not_found", message: "Report not found" });
    expect(body.error.ref).toBe(response.headers.get("x-request-id") as string);
  });

  it("hides the cause of anything unexpected", async () => {
    const response = await call(() => {
      throw new Error("select * from users where password = 'hunter2'");
    });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(body.error.category).toBe("internal");
    expect(body.error.ref).toBeTruthy();
  });

  it("leaves a handler's own error response alone", async () => {
    const response = await call(() => json({ success: false, error: { code: "FORBIDDEN", message: "No" } }, { status: 403 }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  it("reads a body that is not JSON as a 400, not a crash", async () => {
    const response = await call(async ({ request }) => {
      await request.json();
      return json({});
    });
    expect(response.status).toBe(400);
  });
});
