import { describe, expect, test } from "bun:test";
import { decideChatOnly } from "../chat-only";
import { personFrom } from "../delegate";
import { signedSessionCookie } from "../session-cookie";
import { chatBridgeSecret, ReplayGuard, roleKey, verifyStatement } from "../statement";

const SECRET = "a-secret-that-is-long-enough-to-be-accepted";
const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** What the assistant's `signStatement` writes. */
async function sign(secret: string, claims: Record<string, unknown>): Promise<string> {
  const body = b64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}

const soon = () => Math.floor(Date.now() / 1000) + 60;

describe("statements from the assistant", () => {
  test("a genuine, unexpired statement for the right audience is accepted", async () => {
    const token = await sign(SECRET, { aud: "report-delegate", sub: "a@b.c", exp: soon(), jti: "1" });
    expect((await verifyStatement(SECRET, token, "report-delegate"))?.sub).toBe("a@b.c");
  });

  test("everything else is refused", async () => {
    const good = { aud: "report-delegate", sub: "a@b.c", exp: soon(), jti: "1" };
    expect(await verifyStatement(SECRET, await sign("another-secret-of-sufficient-length-xx", good), "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, await sign(SECRET, { ...good, aud: "embed" }), "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, await sign(SECRET, { ...good, exp: 1 }), "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, await sign(SECRET, { ...good, sub: "" }), "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, await sign(SECRET, { ...good, jti: undefined }), "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, null, "report-delegate")).toBeNull();
    expect(await verifyStatement(SECRET, "not-a-statement", "report-delegate")).toBeNull();

    // A payload swapped under somebody else's signature.
    const token = await sign(SECRET, good);
    const forged = `${b64url(JSON.stringify({ ...good, sub: "admin@admin.com" }))}.${token.split(".")[1]}`;
    expect(await verifyStatement(SECRET, forged, "report-delegate")).toBeNull();
  });

  test("a statement works once", () => {
    const guard = new ReplayGuard();
    expect(guard.accept("x", soon())).toBe(true);
    expect(guard.accept("x", soon())).toBe(false);
    expect(guard.accept("y", soon())).toBe(true);
  });

  test("the integration is off without a real secret", () => {
    expect(chatBridgeSecret({})).toBeNull();
    expect(chatBridgeSecret({ CHAT_BRIDGE_SECRET: "short" })).toBeNull();
    expect(chatBridgeSecret({ CHAT_BRIDGE_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("who the assistant says somebody is", () => {
  test("application and reporting spellings of a role are one role", () => {
    expect(roleKey("sales_manager")).toBe("sales_manager");
    expect(roleKey("Sales Manager")).toBe("sales_manager");
    expect(roleKey("Administrator (model role)")).toBe("administrator");
  });

  test("the claims are read strictly", () => {
    const base = { aud: "report-delegate", exp: soon(), jti: "1" };
    expect(personFrom({ ...base, sub: "Jane@Example.com", name: "Jane", roles: ["a", 3, "b"], admin: "yes" })).toEqual({
      email: "jane@example.com",
      name: "Jane",
      roles: ["a", "b"],
      admin: false,
    });
    expect(personFrom({ ...base, sub: "not-an-address" })).toBeNull();
    expect(personFrom({ ...base, sub: "a@b.c", admin: true })?.admin).toBe(true);
  });
});

describe("the session cookie", () => {
  test("is `<token>.<base64 hmac>`, URI-encoded, with the attributes it was given", async () => {
    const cookie = await signedSessionCookie("ers.session_token", "tok", SECRET, {
      maxAge: 60,
      secure: true,
      sameSite: "lax",
    });
    const [pair, ...attributes] = cookie.split("; ");
    const value = decodeURIComponent((pair ?? "").slice("ers.session_token=".length));
    expect(value.startsWith("tok.")).toBe(true);
    expect(Buffer.from(value.slice(4), "base64").length).toBe(32);
    expect(attributes).toEqual(["Path=/", "Max-Age=60", "HttpOnly", "Secure", "SameSite=Lax"]);
  });
});

describe("chat-only mode", () => {
  const base = {
    chatOnly: true,
    isNavigation: true,
    destination: "document",
    email: "jane@example.com",
    isAdmin: false,
    embedFor: "jane@example.com",
  };

  test("a page typed into the address bar goes to the chat", () => {
    expect(decideChatOnly(base)).toBe("to-chat");
  });

  test("the same page inside the assistant's frame, through a ticket, is served", () => {
    expect(decideChatOnly({ ...base, destination: "iframe" })).toBe("serve");
  });

  test("a frame without a ticket, or with somebody else's, is not enough", () => {
    expect(decideChatOnly({ ...base, destination: "iframe", embedFor: null })).toBe("to-chat");
    expect(decideChatOnly({ ...base, destination: "iframe", embedFor: "john@example.com" })).toBe("to-chat");
  });

  test("administrators, the sign-in page and script requests are left alone", () => {
    expect(decideChatOnly({ ...base, isAdmin: true })).toBe("serve");
    expect(decideChatOnly({ ...base, email: null })).toBe("serve");
    expect(decideChatOnly({ ...base, isNavigation: false })).toBe("serve");
  });

  test("with the switch off nothing changes", () => {
    expect(decideChatOnly({ ...base, chatOnly: false })).toBe("serve");
  });
});
