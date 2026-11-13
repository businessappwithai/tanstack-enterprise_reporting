/**
 * Signed, short-lived statements from the chat assistant.
 *
 * The assistant (the `assistant/` service in the orchestrator) is the front
 * door a person may use instead of signing in here. It proves who it is asking
 * for with a statement signed by `CHAT_BRIDGE_SECRET`, in two uses:
 *
 *  - `aud: "report-delegate"` — "give this person a session" (see `delegate.ts`);
 *  - `aud: "embed"` — the cookie that says a page load came through a ticket
 *    the assistant issued.
 *
 * The format is `<base64url(JSON)>.<base64url(HMAC-SHA256)>`: one algorithm, no
 * header to negotiate. This is a copy of the assistant's `signing.ts` verifier;
 * keep the two in step.
 */

export interface Statement {
  aud: string;
  /** The person's e-mail address, lower-cased. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Unique id, so a replay can be refused. */
  jti: string;
  [claim: string]: unknown;
}

const encoder = new TextEncoder();

const fromBase64Url = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The chat integration is off unless a real secret is configured. */
export function chatBridgeSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.CHAT_BRIDGE_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

/** The payload when the statement is genuine, unexpired and for `audience`; otherwise null. */
export async function verifyStatement(
  secret: string,
  token: string | null | undefined,
  audience: string,
  now: number = Date.now()
): Promise<Statement | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  if (!sameBytes(await hmac(secret, body), fromBase64Url(token.slice(dot + 1)))) return null;
  let payload: Statement;
  try {
    payload = JSON.parse(Buffer.from(fromBase64Url(body)).toString("utf8")) as Statement;
  } catch {
    return null;
  }
  if (payload.aud !== audience) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (typeof payload.jti !== "string" || payload.jti.length === 0) return null;
  return payload;
}

/**
 * Refuses a statement it has already seen. A delegation assertion lives for a
 * minute; remembering ids for that long is enough to make it single-use.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  /** True the first time an id is presented; false after. */
  accept(jti: string, exp: number, now: number = Date.now()): boolean {
    for (const [id, until] of this.seen) if (until <= now) this.seen.delete(id);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, exp * 1000);
    return true;
  }
}

/** `sales_manager`, `Sales Manager` and `Sales Manager (model role)` are one role. */
export function roleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(model role\)\s*$/, "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .join("_");
}
