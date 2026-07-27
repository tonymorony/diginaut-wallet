// Network-conditional page chrome (#61). One build serves every network, so
// the banner and title are decided at runtime from the node's reported chain
// — never baked into the HTML.
//
// Beta posture (#54/#63) also lives here: the $500/tx cap is per-transaction,
// mainnet-only, with NO cumulative tracking. It sits on top of the consensus
// limits (DD_TX_LIMITS) — this is a client-side beta ceiling, not consensus.
export const BETA_TX_CAP_USD = 500;

/** The beta-cap violation message, or null when the amount is allowed.
 * usdAmount == null means the USD value is unknowable (no price feed) —
 * decision #54: warn on the confirm screen, but ALLOW the transaction.
 * Accepts both mainnet spellings — the node says 'main', the wallet's
 * netName says 'mainnet' — so a mixed-up caller can't silently drop the cap. */
export function betaCapError(netName, usdAmount) {
  if (netName !== 'mainnet' && netName !== 'main') return null;
  if (usdAmount == null) return null;
  if (usdAmount <= BETA_TX_CAP_USD) return null;
  return `during the mainnet beta, transactions are capped at $${BETA_TX_CAP_USD} each`;
}

/** May the seed-backup ceremony offer "Remind me later" on this chain? (#C3)
 * Inverted default vs betaCapError on purpose: the cap warn-allows what it
 * cannot price, but an unnameable chain here is a mainnet deployment whose
 * node is down, and "skip your only backup" must never be the fail-open.
 * ALLOW-LIST, not a deny-list: 'test'/'testnet'/'regtest' only. Accepts both
 * spellings for the same reason betaCapError does — the node says 'test', the
 * wallet's netName says 'testnet'. */
export function backupSkipAllowed(chain) {
  return chain === 'test' || chain === 'testnet' || chain === 'regtest';
}

export function networkChrome(chain) {
  switch (chain) {
    case 'test':
      return {
        title: 'Diginaut · DigiDollar testnet wallet',
        banner: 'TESTNET ONLY — no real value. Keys live in this browser; there is no server-side backup.',
        level: 'warn',
        pill: 'TESTNET',
      };
    case 'regtest':
      return {
        title: 'Diginaut · DigiDollar regtest wallet',
        banner: 'REGTEST — developer network, coins have no value.',
        level: 'warn',
        pill: 'REGTEST',
      };
    case 'main':
      // Copy decided in #54 — loud, red (level:'danger'), and honest about the cap.
      return {
        title: 'Diginaut · DigiDollar wallet',
        // "no backup" was false and dangerous on the one chain with real funds:
        // mainnet ships a MANDATORY seed ceremony plus an encrypted file export,
        // so the bare phrase told a user their backup did not exist. Testnet
        // already qualified it ("no server-side backup") — the loud chain must
        // not make the weaker, wronger claim. What is absent is OUR copy of it.
        banner: `MAINNET BETA — real funds at risk. Beta software, in-browser keys, no backup on our servers. $${BETA_TX_CAP_USD}/tx cap.`,
        level: 'danger',
        pill: 'MAINNET',
      };
    default:
      // Chain not yet known (or a network we don't name): claim nothing.
      return { title: 'Diginaut · DigiDollar wallet', banner: null, level: null, pill: null };
  }
}
