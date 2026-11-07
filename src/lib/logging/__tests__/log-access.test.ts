import { describe, expect, it } from "bun:test";
import { applyScope, mayReadWhole, scopeFor, shapeForViewer } from "../log-access";

const admin = { id: "admin-1", isAdmin: true };
const member = { id: "user-1", isAdmin: false };

const row = (overrides = {}) => ({
  id: "r1",
  user_id: "user-2" as string | null,
  user_email: "someone@example.com",
  level: "error",
  message: "Query failed",
  error_stack: "at secret (/srv/app/lib/db.ts:12)",
  metadata: '{"dataSourceId":"ds-9"}',
  session_id: "sess-2",
  message_vector: "[0.1]",
  ...overrides,
});

describe("scopeFor", () => {
  it("lets an administrator see everyone, or one person when they pick one", () => {
    expect(scopeFor(admin)).toEqual({ kind: "everyone" });
    expect(scopeFor(admin, { userId: "user-2" })).toEqual({ kind: "user", userId: "user-2" });
  });

  it("gives anyone else their own rows and the system's, and nothing about another user's", () => {
    expect(scopeFor(member)).toEqual({ kind: "own-and-system", viewerId: "user-1" });
    // Asking for another user's rows by id does not widen it.
    expect(scopeFor(member, { userId: "user-2" })).toEqual({ kind: "own-and-system", viewerId: "user-1" });
  });

  it("adds a request reference, bounded, for the person who holds it", () => {
    expect(scopeFor(member, { requestId: "abc-123" })).toEqual({
      kind: "own-and-system",
      viewerId: "user-1",
      requestId: "abc-123",
    });
    const long = scopeFor(member, { requestId: "x".repeat(200) });
    expect(long.kind === "own-and-system" && long.requestId?.length).toBe(64);
    expect(scopeFor(member, { requestId: "" })).toEqual({ kind: "own-and-system", viewerId: "user-1" });
  });

});

describe("shapeForViewer", () => {
  it("shows an owner their own row whole", () => {
    const shaped = shapeForViewer(member, row({ user_id: "user-1" }));
    expect(shaped.visibility).toBe("full");
    expect(shaped.error_stack).toContain("secret");
  });

  it("shows an administrator everything", () => {
    const shaped = shapeForViewer(admin, row());
    expect(shaped.visibility).toBe("full");
    expect(shaped.metadata).toContain("ds-9");
  });

  it("strips the stack, the fields and the session from a row that is not theirs", () => {
    const shaped = shapeForViewer(member, row());
    expect(shaped.visibility).toBe("limited");
    expect(shaped.error_stack).toBeNull();
    expect(shaped.metadata).toBeNull();
    expect(shaped.session_id).toBeNull();
    expect(shaped.message_vector).toBeNull();
    expect(shaped.message).toBe("Query failed");
  });

  it("does not say whose a limited row is", () => {
    const other = shapeForViewer(member, row());
    expect(other.user_id).toBeNull();
    expect(other.user_email).toBe("another user");
    const system = shapeForViewer(member, row({ user_id: null }));
    expect(system.user_email).toBe("system");
  });

  it("never lets a row with no owner count as the viewer's", () => {
    expect(mayReadWhole(member, row({ user_id: null }))).toBe(false);
    expect(mayReadWhole({ id: "", isAdmin: false }, row({ user_id: "" }))).toBe(false);
  });
});

describe("applyScope", () => {
  /** A stand-in for the builder that records what was asked of it. */
  function recorder() {
    const calls: unknown[][] = [];
    const eb: any = (column: string, op: string, value: unknown) => ({ column, op, value });
    eb.or = (parts: unknown[]) => ({ or: parts });
    eb.and = (parts: unknown[]) => ({ and: parts });
    const query = {
      where(...args: unknown[]) {
        calls.push(args.map((a) => (typeof a === "function" ? (a as (eb: unknown) => unknown)(eb) : a)));
        return query;
      },
    };
    return { query, calls };
  }

  it("does nothing for an administrator who has not picked a user", () => {
    const { query, calls } = recorder();
    applyScope(query, { kind: "everyone" });
    expect(calls).toEqual([]);
  });

  it("filters to one user when an administrator picks one", () => {
    const { query, calls } = recorder();
    applyScope(query, { kind: "user", userId: "user-2" });
    expect(calls).toEqual([["user_id", "=", "user-2"]]);
  });

  it("allows own rows, then the system's errors and non-request warnings, then a held reference — and nothing else", () => {
    const { query, calls } = recorder();
    applyScope(query, { kind: "own-and-system", viewerId: "user-1", requestId: "ref-1" });
    expect(calls).toEqual([
      [
        {
          or: [
            { column: "user_id", op: "=", value: "user-1" },
            {
              and: [
                { column: "user_id", op: "is", value: null },
                {
                  or: [
                    { column: "level", op: "=", value: "error" },
                    {
                      and: [
                        { column: "level", op: "=", value: "warn" },
                        { column: "component", op: "!=", value: "http" },
                      ],
                    },
                  ],
                },
              ],
            },
            { column: "request_id", op: "=", value: "ref-1" },
          ],
        },
      ],
    ]);
  });

  it("leaves the reference clause out when none is held", () => {
    const { query, calls } = recorder();
    applyScope(query, { kind: "own-and-system", viewerId: "user-1" });
    const clause = (calls[0]![0] as { or: unknown[] }).or;
    expect(clause).toHaveLength(2);
  });
});
