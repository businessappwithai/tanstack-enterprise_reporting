/**
 * Work to finish before the process exits.
 *
 * The logger flushes its buffer on SIGTERM; so must the span exporter, or the last seconds of
 * traces are lost exactly when someone most wants them. Both register here and the signal
 * handler waits for all of them, so neither can exit the process under the other.
 */

const hooks: Array<() => Promise<void> | void> = [];

export function onShutdown(hook: () => Promise<void> | void): void {
  hooks.push(hook);
}

/** Run every hook; one failing never stops the rest. */
export async function runShutdownHooks(): Promise<void> {
  await Promise.allSettled(hooks.map(async (hook) => hook()));
}
