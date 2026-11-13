/**
 * Chat-only mode: when the administrator has made the chat assistant the only
 * way in, a page of this platform loads only inside the assistant's frame.
 *
 * The switch itself lives in the generated application (Admin → System
 * Config); the assistant relays it at `CHAT_SWITCHES_URL`. This module decides,
 * for one page load, whether to serve it or send the person to the chat.
 *
 * What it is and is not: it stops a person *working* here outside the chat —
 * following a bookmark, typing the address. It is not what protects data;
 * every query is still checked against the person's own permissions wherever
 * the page is drawn. Administrators are exempt, so that somebody can always
 * reach the platform if the assistant is down.
 */
export interface ChatOnlyInput {
  /** The administrator's switch, as last relayed. */
  chatOnly: boolean;
  /** `Sec-Fetch-Mode: navigate` — a document load, not a script's request. */
  isNavigation: boolean;
  /** `Sec-Fetch-Dest`. */
  destination: string | null;
  /** The signed-in person, or null when nobody is. */
  email: string | null;
  isAdmin: boolean;
  /** Who the embed cookie was issued to, when it is present and genuine. */
  embedFor: string | null;
}

export type ChatOnlyVerdict = "serve" | "to-chat";

export function decideChatOnly(input: ChatOnlyInput): ChatOnlyVerdict {
  if (!input.chatOnly || !input.isNavigation) return "serve";
  // Nobody signed in: the sign-in page stays reachable, or an administrator could never get in.
  if (!input.email) return "serve";
  if (input.isAdmin) return "serve";
  const inFrame = input.destination === "iframe";
  const ticketed = input.embedFor !== null && input.embedFor === input.email.toLowerCase();
  return inFrame && ticketed ? "serve" : "to-chat";
}

interface Switches {
  enabled: boolean;
  chatOnly: boolean;
}

let cached: { until: number; value: Switches } | null = null;

/** The switches as the assistant last relayed them. An assistant that cannot be asked means "not chat-only". */
export async function chatSwitches(
  url: string | undefined = process.env.CHAT_SWITCHES_URL,
  now: number = Date.now()
): Promise<Switches> {
  if (!url) return { enabled: false, chatOnly: false };
  if (cached && cached.until > now) return cached.value;
  let value: Switches = cached?.value ?? { enabled: false, chatOnly: false };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    // The assistant answers 503 while it does not know yet (just restarted, nobody signed in
    // since). That is "ask again", not "off": the last answer stands.
    if (response.ok) {
      const body = (await response.json()) as Partial<Switches>;
      value = { enabled: body.enabled === true, chatOnly: body.chatOnly === true };
    }
  } catch {
    // Keep the last known answer. With none at all this is "not chat-only": the lock is on
    // where people work, never on what they may read, and locking everyone out of the
    // platform because another service is down is the worse failure. The assistant keeps
    // its last reading across restarts so that this window is rare.
  }
  cached = { until: now + 20_000, value };
  return value;
}

const cookieValue = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};

/** Where to send this request instead of serving it, or null to serve it. */
export async function chatOnlyRedirect(request: Request): Promise<string | null> {
  if (process.env.CHAT_EMBED !== "1") return null;
  if (request.method !== "GET" || request.headers.get("sec-fetch-mode") !== "navigate") return null;
  const path = new URL(request.url).pathname;
  if (path.includes("/api/") || path.endsWith("/login")) return null;

  const { chatBridgeSecret, verifyStatement } = await import("./statement");
  const secret = chatBridgeSecret();
  if (!secret) return null;
  const switches = await chatSwitches();
  if (!switches.chatOnly) return null;

  // "Could not check" is not "signed out". Only an outage is tolerated here — the page
  // itself will say so — and anything else is a fault that must not pass for nobody
  // being signed in, which would switch chat-only mode off for everyone without a word.
  const { getSessionFromHeaders, SessionUnavailableError } = await import("@/lib/auth/session");
  let session: Awaited<ReturnType<typeof getSessionFromHeaders>> = null;
  try {
    session = await getSessionFromHeaders(request.headers);
  } catch (error) {
    if (!(error instanceof SessionUnavailableError)) throw error;
    return null;
  }
  const roles = session?.user.roles ?? [];
  const permissions = session?.user.permissions ?? [];
  const embed = await verifyStatement(secret, cookieValue(request.headers.get("cookie"), "chat_embed"), "embed");

  const verdict = decideChatOnly({
    chatOnly: true,
    isNavigation: true,
    destination: request.headers.get("sec-fetch-dest"),
    email: session?.user.email ?? null,
    isAdmin:
      roles.some((role) => role.toLowerCase().includes("admin")) ||
      permissions.includes("*:*") ||
      permissions.includes("admin:*"),
    embedFor: embed?.sub ?? null,
  });
  return verdict === "to-chat" ? (process.env.CHAT_URL ?? "/chat/") : null;
}
