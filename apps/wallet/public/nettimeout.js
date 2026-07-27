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
