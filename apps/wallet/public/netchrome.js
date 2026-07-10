// Network-conditional page chrome (#61). One build serves every network, so
// the banner and title are decided at runtime from the node's reported chain
// — never baked into the HTML.
export function networkChrome(chain) {
  switch (chain) {
    case 'test':
      return {
        title: 'Diginaut · DigiDollar testnet wallet',
        banner: 'TESTNET ONLY — no real value. Keys live in this browser; there is no server-side backup.',
      };
    case 'regtest':
      return {
        title: 'Diginaut · DigiDollar regtest wallet',
        banner: 'REGTEST — developer network, coins have no value.',
      };
    case 'main':
      // The mainnet beta warning (copy, limits) is decided in #54 and lands
      // with #63 — until then mainnet shows no banner rather than a wrong one.
      return { title: 'Diginaut · DigiDollar wallet', banner: null };
    default:
      // Chain not yet known (or a network we don't name): claim nothing.
      return { title: 'Diginaut · DigiDollar wallet', banner: null };
  }
}
