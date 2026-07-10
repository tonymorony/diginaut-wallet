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
    if (raw.includes(token)) return `${text} (node: ${token})`;
  }
  for (const [prefix, text] of FAMILY_MESSAGES) {
    const m = raw.match(new RegExp(`${prefix}[a-z0-9-]*`));
    if (m) return `${text} (node: ${m[0]})`;
  }
  return null;
}
