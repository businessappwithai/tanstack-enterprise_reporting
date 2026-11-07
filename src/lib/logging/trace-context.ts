/**
 * Joining a log line to a trace, and keeping the volume of debug output in hand.
 *
 * Plain functions, no framework, so the contract is tested with plain values.
 *
 * **Trace ids.** A request may arrive carrying a W3C `traceparent` header
 * (`00-<32 hex trace id>-<16 hex parent span id>-<2 hex flags>`) from a gateway or another
 * service. Parsing it needs no library, and putting its ids on every log line written for
 * that request is what lets a trace in a collector be joined to the lines it produced.
 * Anything that is not exactly that shape is ignored — a header is caller input, and these
 * ids are written into the log.
 *
 * **Debug sampling.** `LOG_SAMPLE_DEBUG=0.1` keeps a tenth of requests' debug and trace
 * lines. The decision is a hash of the request id, so a request is either read end to end or
 * not at all; sampling lines independently would leave every request half-explained.
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO = /^0+$/;

export interface TraceIds {
  traceId: string;
  spanId: string;
  /** The caller's sampled flag. Informational: this process does not trace. */
  sampled: boolean;
}

export function parseTraceparent(header: unknown): TraceIds | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT.exec(header);
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  // The spec makes an all-zero id invalid, and says to ignore the header when it is.
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

/** `LOG_SAMPLE_DEBUG`, as a rate in [0, 1]. Unset or unreadable means keep everything. */
export function sampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** FNV-1a: small, stable, and spreads similar ids (UUIDs share most of their bytes). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether this request's debug and trace lines are kept. Warnings and above are not asked:
 * sampling never drops something an operator needs to see.
 */
export function keepDebug(
  requestId: string | undefined,
  rate: number,
  random: () => number = Math.random,
): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  if (!requestId) return random() < rate;
  return hash(requestId) % 10000 < rate * 10000;
}
