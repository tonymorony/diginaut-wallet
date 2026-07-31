// Client-side network budgets (#H1). Every frontend fetch was bare: a hung
// socket never settles, so the awaiting flow's button stays disabled forever
// (busy() only re-enables in `finally`) and a poll chain that awaits it stops
// rescheduling for the rest of the session.
//
// Each budget MUST exceed the wallet server's own upstream budget for that
// path, so the server's descriptive 502 (e.g. "indexer unreachable: …", which
// refreshMoney already translates to friendly "still syncing" copy) wins the
// race, and the client abort only fires when the browser <-> wallet-server hop
// itself is dead. Upstream budgets live in server.js:
//   rpc      callNode          AbortSignal.timeout(15_000)
//   indexer  /api/indexer      AbortSignal.timeout(15_000)
//   faucet   /api/faucet/claim AbortSignal.timeout(30_000)
export const NET_TIMEOUT_MS = Object.freeze({
  rpc: 20_000,
  indexer: 20_000,
  faucet: 35_000,
  config: 10_000,
  priceHistory: 10_000,
});

// AbortSignal.timeout rejects with DOMException 'TimeoutError'; an explicit
// abort (or an older engine) gives 'AbortError'. Both mean "no answer".
export const isTimeoutError = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError';

/** Plain-language text for a dead/stalled hop. `what` names the peer.
 *  Deliberately makes NO claim about what happened on the far side and never
 *  says "try again": the same wrapper carries sendrawtransaction, where a
 *  timeout means the broadcast may well have landed. Callers that KNOW the
 *  request was read-only add their own reassurance; the broadcast path adds
 *  the ambiguity warning instead. */
export function timeoutMessage(what) {
  return `${what} did not answer in time — it may be down, or the connection dropped.`;
}

// ---- Retry policy for indexer reads (fetchIndexer's ladder) ----

/** Backoff rungs, in ms. Short on purpose: this covers a service restart, not
 *  an outage. */
export const INDEXER_RETRY_MS = Object.freeze([500, 1_000, 2_000]);

/** Wall-clock cap on the retries of ONE read, measured from the first attempt.
 *  Counting attempts alone is not a time bound: a hop that HANGS costs a full
 *  NET_TIMEOUT_MS.indexer each rung, so the ladder would stack ~83 s of blank
 *  loading veil with the autolock ticking. Deliberately smaller than that
 *  budget, so one stalled attempt ends the ladder by itself and the error
 *  surfaces in roughly single-attempt time, while the fast-failing 'network'
 *  case — the restart this exists for — still gets every rung (3.5 s total). */
export const INDEXER_RETRY_BUDGET_MS = 10_000;

/** Is this failed indexer read worth another attempt? Exactly two shapes are:
 *   - the browser↔wallet-server hop died or stalled — apiFetch's `transport`;
 *   - the wallet server answered, relaying a dead indexer hop: its own 502 from
 *     handleIndexer. That is the shape a `docker compose up -d` actually makes
 *     (the indexer bounces, the wallet server does not), and it arrives as a
 *     NORMAL response, so it never reaches apiFetch's catch.
 *  The relay is matched by BOTH the message it carries today and the `cause`
 *  token of the indexer error contract, so this and that contract can land in
 *  either order without one silently disarming the other.
 *  Everything else is an ANSWER — a 4xx, the 503 "no indexer configured", a
 *  shape refusal — and retrying an answer only makes the honest error slower. */
export function transientIndexerFailure({ transport = null, status = 0, body = null } = {}) {
  if (transport === 'timeout' || transport === 'network') return true;
  if (status !== 502) return false;
  return body?.cause === 'indexer-unreachable' || /indexer unreachable/i.test(String(body?.error ?? ''));
}
