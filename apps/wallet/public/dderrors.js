// DigiDollar consensus reject strings → actionable errors (#62).
// The node's sendrawtransaction surfaces Core's raw reject tokens
// (digidollar/validation.cpp); a human can't act on "minting-frozen-volatility".
// Each translation keeps the raw token so support/debugging still has it.
// Unknown messages return null — the caller shows the original text.

// shared with the mint flow's pre-sign gate — one place for the freeze wording
export const MINT_FREEZE_EXPLANATION =
  'Minting is temporarily frozen by consensus: the DGB price moved 20% or more within an hour.';

const TOKEN_MESSAGES = [
  ['minting-frozen-volatility', // matches the -candidate variant too
    MINT_FREEZE_EXPLANATION +
    ' Your funds are untouched — the network refused the transaction. Try again once the market calms.'],
  ['all-operations-frozen',
    'All DigiDollar operations are frozen by consensus: the DGB price moved 50% or more within 7 days. ' +
    'Minting, transfers and redemptions resume automatically when volatility subsides.'],
  ['bad-dd-mint-amount',
    'The node rejected the amount: it is outside this network’s consensus mint limits.'],
  ['bad-oracle-price',
    'The node rejected the oracle price this transaction was built against. ' +
    'The network may be between price updates — try again in a few minutes.'],
];

const FAMILY_MESSAGES = [
  ['bad-mint-', 'The node rejected this mint transaction at the consensus level.'],
  ['bad-redeem-', 'The node rejected this redemption at the consensus level.'],
  ['bad-oracle-', 'The node rejected the oracle data behind this transaction. Try again in a few minutes.'],
  ['bad-dd-', 'The node rejected this DigiDollar transaction at the consensus level.'],
];

export function friendlyDDError(message) {
  const raw = String(message ?? '');
  for (const [token, text] of TOKEN_MESSAGES) {
    // report the FULL token the node sent (e.g. …-volatility-candidate), not
    // just the prefix we matched on — support needs the exact reject string
    const m = raw.match(new RegExp(`${token}[a-z0-9-]*`));
    if (m) return `${text} (node: ${m[0]})`;
  }
  for (const [prefix, text] of FAMILY_MESSAGES) {
    const m = raw.match(new RegExp(`${prefix}[a-z0-9-]*`));
    if (m) return `${text} (node: ${m[0]})`;
  }
  return null;
}

// ---- Spend/broadcast reject families (#H3) ----
// These are precisely the strings a user meets AFTER an ambiguous broadcast:
// the first attempt DID land, so the raw token invites the worst possible
// response ("rebuild and send again"), which spends the same coins twice into a
// conflicting transaction. The copy has one job: stop, check Activity, do not
// re-send. See broadcastlog.js and the recovery card (#C1).

const SPENT_MESSAGE =
  'The coins this transaction spends are already gone. The usual cause is that an earlier attempt at this SAME '
  + 'transaction was accepted after all. Check Activity before doing anything else — do NOT rebuild and send it '
  + 'again, or you will be trying to spend the same coins twice.';
const CONFLICT_MESSAGE =
  'The node already holds a different transaction spending these same coins — almost always an earlier attempt '
  + 'at this same payment. Wait for it to confirm and check Activity — do NOT send again.';

// Real RegExp literals, not the token-string idiom above: these patterns carry
// spaces and metacharacters that `new RegExp(token + '[a-z0-9-]*')` cannot express.
const SPEND_REJECTS = [
  [/bad-txns-inputs-missingorspent/, SPENT_MESSAGE],
  [/bad-txns-inputs-spent/, SPENT_MESSAGE],
  [/txn-mempool-conflict/, CONFLICT_MESSAGE],
  [/insufficient fee, rejecting replacement/i, CONFLICT_MESSAGE],
  // family catch-all — MUST stay last, or it swallows the two specific
  // messages above and degrades them to this generic line
  [/bad-txns-[a-z0-9-]*/, 'The node rejected this transaction at the consensus level.'],
];

// The node saying it already has this transaction is SUCCESS, not failure — it
// is what an idempotent rebroadcast of identical bytes looks like. Anchored to
// the known Core strings: a bare /already/ would swallow genuine rejects and
// report a failed transaction as sent.
const ALREADY_BROADCAST = [
  /txn-already-in-mempool/i,
  /txn-already-known/i,
  /transaction already in (?:the )?mempool/i,
  /transaction already in block ?chain/i,
  /transaction outputs already in utxo set/i,
  /already have transaction/i,
];

/** True when the node's answer means "I already have this transaction". */
export function isAlreadyBroadcast(message) {
  const raw = String(message ?? '');
  return ALREADY_BROADCAST.some((re) => re.test(raw));
}

/** True when the text is a recognised NODE-LEVEL verdict (accept or reject) —
 *  i.e. the node definitely answered, so the outcome is NOT ambiguous.
 *  Consumed by broadcastlog.js's classifier. Its only sources of truth are the
 *  two curated lists plus friendlyDDError: returning true for transport text
 *  would make a timed-out broadcast look like a definite failure and drop the
 *  recovery record, which is #C1 back through the front door. */
export function isNodeRejectString(message) {
  const raw = String(message ?? '');
  if (isAlreadyBroadcast(raw)) return true;
  if (SPEND_REJECTS.some(([re]) => re.test(raw))) return true;
  return friendlyDDError(raw) !== null;
}

/** One entry point for broadcast failures: already-broadcast, then the
 *  spend/conflict families, then the DigiDollar consensus families. Returns
 *  null for anything unrecognised — the caller shows the original text. */
export function friendlyRejectError(message) {
  const raw = String(message ?? '');
  if (isAlreadyBroadcast(raw)) {
    return 'The node already has this transaction — it was broadcast successfully. '
      + 'It appears in Activity as pending until the next block confirms it.';
  }
  for (const [re, text] of SPEND_REJECTS) {
    const m = raw.match(re);
    if (m) return `${text} (node: ${m[0]})`; // full token echoed, same contract as friendlyDDError
  }
  return friendlyDDError(raw);
}
