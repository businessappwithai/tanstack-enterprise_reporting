import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { appError, categoryForStatus, classify, ServerFunctionError } from "../app-error";

const driver = (code: string, message = "db said no") => Object.assign(new Error(message), { code });

describe("an error thrown on purpose", () => {
  it("answers the status, category and code the catalogue declares", () => {
    const result = classify(appError("QUERY_ACCESS_DENIED", { message: "You may not read bus_secret" }));
    expect(result.status).toBe(403);
    expect(result.category).toBe("authorization");
    expect(result.code).toBe("QUERY_ACCESS_DENIED");
    expect(result.level).toBe("warn");
  });

  it("keeps its message below 500, because only the caller can fix their query", () => {
    expect(classify(appError("QUERY_ACCESS_DENIED", { message: "You may not read bus_secret" })).message).toBe(
      "You may not read bus_secret"
    );
  });

  it("loses its message at 500 and says the catalogue's instead", () => {
    const result = classify(appError("SERVER_ERROR", { message: "password=hunter2 in config" }));
    expect(result.status).toBe(500);
    expect(result.message).not.toContain("hunter2");
  });
});

describe("the older ServerFunctionError", () => {
  it("is classified by its code when the catalogue knows it", () => {
    const result = classify(new ServerFunctionError("No such report", "NOT_FOUND", 404));
    expect(result.category).toBe("not_found");
    expect(result.level).toBe("info");
  });

  it("is classified by its status when the code is its own", () => {
    const result = classify(new ServerFunctionError("Nope", "SOMETHING_ELSE", 409));
    expect(result.category).toBe("conflict");
    expect(result.code).toBe("SOMETHING_ELSE");
  });

  it("hides the message of a 5xx", () => {
    const result = classify(new ServerFunctionError("connect ECONNREFUSED 10.0.0.9", "INTERNAL_ERROR", 500));
    expect(result.message).not.toContain("10.0.0.9");
  });
});

describe("anything else", () => {
  it("reads a failed session lookup as a database failure, not a sign-out", () => {
    const error = new Error("x");
    error.name = "SessionUnavailableError";
    const result = classify(error);
    expect(result.status).toBe(503);
    expect(result.category).toBe("database");
  });

  it("reads a body that is not JSON as a 400", () => {
    expect(classify(new SyntaxError("Unexpected token")).status).toBe(400);
  });

  it("names the fields a schema refused and never the values", () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: "not-an-email-secret" });
    if (parsed.success) throw new Error("expected a failure");
    const result = classify(parsed.error);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result)).toContain("email");
    expect(JSON.stringify(result)).not.toContain("not-an-email-secret");
  });

  it("reads a unique violation as a conflict and a down database as unavailable", () => {
    expect(classify(driver("23505")).status).toBe(409);
    for (const code of ["ECONNREFUSED", "08006", "57P01"]) {
      const result = classify(driver(code));
      expect(result.code).toBe("DATABASE_UNAVAILABLE");
      expect(result.level).toBe("error");
    }
  });

  it("hides a database error it does not understand", () => {
    const result = classify(driver("42P01", 'relation "config_secret" does not exist'));
    expect(result.status).toBe(500);
    expect(result.message).not.toContain("config_secret");
  });

  it("is internal for a string or null, and says nothing of it", () => {
    for (const thrown of ["boom", null, undefined, { a: 1 }]) {
      expect(classify(thrown).category).toBe("internal");
    }
  });
});

describe("categoryForStatus", () => {
  it("falls to validation for an unknown 4xx and internal for an unknown 5xx", () => {
    expect(categoryForStatus(404)).toBe("not_found");
    expect(categoryForStatus(418)).toBe("validation");
    expect(categoryForStatus(599)).toBe("internal");
  });
});
