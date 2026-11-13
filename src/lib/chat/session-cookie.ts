/**
 * A session cookie signed the way Better Auth signs its own.
 *
 * Better Auth reads `<token>.<base64(HMAC-SHA256(secret, token))>`,
 * URI-encoded. Sign-in normally writes it; the delegated sign-in creates the
 * session through Better Auth's adapter and has to write the same cookie by
 * hand. `delegate.test.ts` holds this to `getSession`, so a Better Auth that
 * changes the format fails a test rather than every delegated sign-in.
 */
export interface SessionCookieAttributes {
  maxAge?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export async function signedSessionCookie(
  name: string,
  token: string,
  secret: string,
  attributes: SessionCookieAttributes = {}
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(token)));
  const value = encodeURIComponent(`${token}.${Buffer.from(signature).toString("base64")}`);

  const parts = [`${name}=${value}`, `Path=${attributes.path ?? "/"}`];
  if (typeof attributes.maxAge === "number") parts.push(`Max-Age=${Math.floor(attributes.maxAge)}`);
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  if (attributes.httpOnly !== false) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  const sameSite = String(attributes.sameSite ?? "lax").toLowerCase();
  parts.push(`SameSite=${sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax"}`);
  return parts.join("; ");
}
