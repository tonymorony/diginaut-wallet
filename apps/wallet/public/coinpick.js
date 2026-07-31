// Which single DGB coin pays the DGB side of a DigiDollar transaction (#103).
// Pulled out of app.js so the tier order can be pinned by a test: inline, an
// inverted tier or a largest-first sort would have passed every suite in the
// repo (same reason autolock.js was extracted — see autolock.test.js).

/** The single DGB coin that pays a DigiDollar transaction's DGB side — the fee
 * on a transfer or a redemption, the whole funding on a mint. Tiered: a
 * key-path P2TR coin on the preferred key first (Core's own anatomy, cheapest
 * witness), then any P2TR coin in the wallet, then a P2WPKH twin — mint change
 * (#38), which the builders sign per BIP-143. Smallest sufficient coin wins, so
 * a large one stays whole. Undefined when no single coin covers `minSats`.
 * `preferKeyHex` is optional: a mint has no incumbent key to prefer. */
export function pickDgbCoin(utxos, minSats, preferKeyHex) {
  const enough = utxos.filter((u) => u.valueSats >= minSats).sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1));
  const taproot = enough.filter((u) => u.type !== 'p2wpkh');
  return taproot.find((u) => u.privKeyHex === preferKeyHex)
    ?? taproot[0]
    ?? enough.find((u) => u.type === 'p2wpkh');
}
