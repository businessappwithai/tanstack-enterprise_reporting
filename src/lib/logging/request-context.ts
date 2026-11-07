/**
 * What every log line written during one request should carry, without each
 * call site being handed it.
 *
 * `withApiHandler` opens a context at the top of a request; the logger reads it
 * on every event, so a line written three calls deep still names the request
 * and the signed-in user. Outside a request (a worker, a script) there is no
 * context and the fields are simply absent.
 */

import type { AsyncLocalStorage as AsyncLocalStorageType } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  userId?: string | null;
  route?: string;
  /** What a route's own `catch` noted before it answered, for the request's one log line. */
  failure?: { err: unknown; note: string };
}

/**
 * Loaded without a static import so this module can sit in a bundle the browser also receives:
 * the logger is imported by pages that render on both sides, and `node:async_hooks` does not
 * exist in a browser. Where it is missing there is no request to carry a context for, and every
 * function here degrades to "no context".
 */
function createStorage(): AsyncLocalStorageType<RequestContext> | undefined {
  try {
    const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
      ?.getBuiltinModule;
    const mod = builtin?.("node:async_hooks") as typeof import("node:async_hooks") | undefined;
    return mod ? new mod.AsyncLocalStorage<RequestContext>() : undefined;
  } catch {
    return undefined;
  }
}

const storage = createStorage();

export function currentRequestContext(): RequestContext | undefined {
  return storage?.getStore();
}

/** Run `fn` with this context in scope for everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage ? storage.run(context, fn) : fn();
}

/** Add to the open context, if there is one (the user, once the session is known). */
export function setRequestContext(partial: Partial<RequestContext>): void {
  const store = storage?.getStore();
  if (store) Object.assign(store, partial);
}

/**
 * Note the cause of a failure a route is about to answer itself.
 *
 *     } catch (error) {
 *       recordFailure(error, "Error fetching report");
 *       return json({ success: false, error: { … } }, { status: 500 });
 *     }
 *
 * It replaces `console.error(label, error)`: nothing is printed here. The request's single
 * `http.request.failed` line carries the cause (with its stack) and the label, so a failure is
 * one line, not a request line plus a stray console line that shares no id with it.
 */
export function recordFailure(err: unknown, note: string): void {
  const store = storage?.getStore();
  if (store) store.failure = { err, note };
}

/**
 * A caller may supply its own request id so a line here and a line in the
 * caller's log can be joined. It is written into every log line and echoed in a
 * response header, so it is accepted only as the plain token it should be: a
 * header value with a newline in it would otherwise forge a second log line.
 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function acceptRequestId(supplied: string | null | undefined): string {
  return supplied && REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
}
