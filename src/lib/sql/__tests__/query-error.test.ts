import { describe, expect, it } from "bun:test";
import { toQueryError } from "../query-error";

const driver = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("toQueryError", () => {
  it("gives a person back the database's message when their query is wrong", () => {
    for (const code of ["42P01", "42703", "22P02", "ER_PARSE_ERROR", "EREQUEST"]) {
      const result = toQueryError(driver(code, 'relation "bus_acount" does not exist'));
      expect(result.code, code).toBe("QUERY_FAILED");
      expect(result.statusCode).toBe(400);
      expect(result.message).toContain("bus_acount");
    }
  });

  it("does not hand over the message when the data source could not be reached", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "08006", "28P01"]) {
      const result = toQueryError(driver(code, "connect ECONNREFUSED 10.1.2.3:5432"));
      expect(result.code, code).toBe("DATABASE_CONNECTION_FAILED");
      expect(result.message).not.toContain("10.1.2.3");
    }
  });

  it("reads a timeout as one, and anything it does not understand as an integration failure", () => {
    expect(toQueryError(driver("57014", "canceling statement due to statement timeout")).code).toBe("QUERY_TIMEOUT");
    expect(toQueryError(driver("XX000", "internal driver detail")).code).toBe("INTEGRATION_FAILED");
    expect(toQueryError("boom").code).toBe("INTEGRATION_FAILED");
  });

  it("bounds what it passes on", () => {
    expect(toQueryError(driver("42601", "x".repeat(5000))).message.length).toBeLessThanOrEqual(500);
  });
});
