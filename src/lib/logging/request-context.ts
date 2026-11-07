/**
 * What every log line written during one request should carry, without each
 * call site being handed it.
 *
 * `withApiHandler` opens a context at the top of a request; the logger reads it
 * on every event, so a line written three calls deep still names the request
 * and the signed-in user. Outside a request (a worker, a script) there is no
 * context and the fields are simply absent.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  userId?: string | null;
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with this context in scope for everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Add to the open context, if there is one (the user, once the session is known). */
export function setRequestContext(partial: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, partial);
}

/**
 * A caller may supply its own request id so a line here and a line in the
 * caller's log can be joined. It is written into every log line and echoed in a
 * response header, so it is accepted only as the plain token it should be: a
 * header value with a newline in it would otherwise forge a second log line.
 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function acceptRequestId(supplied: string | null | undefined): string {
  return supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID();
}
