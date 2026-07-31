# packages/digidollar-js

Verified: 2026-07-26 @ `7247899`; the `txbuild.js` row and the flexible-DGB-leg section
below re-verified 2026-07-31 @ `05c57b2` — that section only, not the whole page. (A commit
hash, not a branch name: branches stop resolving once merged and deleted, which is exactly
when a stamp has to be judged.) ADR-0004: deterministic, zero I/O. All money is BigInt
(DGB in sats, DD in **cents**, oracle price in micro-USD/DGB). Deps pinned exactly:
`@noble/curves`, `@scure/bip32`, `@scure/bip39`. Consumed by wallet, indexer, faucet.

## Modules (entry: `src/index.js`, re-exports everything)

| Module | Exports (essentials) | Mirrors (Core v9.26.4) |
|---|---|---|
| `index.js` | `COIN`, `LOCK_TIERS` (10 tiers), `tierById`, `effectiveRatioPercent` (DCA ceiling), `requiredCollateralSats`, `DD_TX_LIMITS` (per-network; regtest 1–100k cents) | `consensus/digidollar.h`, `dca.cpp`, `txbuilder.cpp` |
| `envelope.js` | build/parse for DD nVersion marker (`0x0770`, type 1/2/3 = mint/transfer/redeem) + mint/transfer/redeem OP_RETURN metadata | `consensus/digidollar.cpp` |
| `taproot.js` | `ddTokenOutputKey` (key-path-only), `collateralOutputKey` (NUMS + 2-leaf MAST), redemption leaf + control block; `COLLATERAL_NUMS_KEY` | `digidollar/scripts.{h,cpp}` |
| `address.js` (324 L) | bech32/bech32m encode/decode, `scriptPubKeyFromAddress`, DD base58check `encodeDDAddress`/`decodeDDAddress`/`toDDAddress`, legacy decode, unified `decodeAddress(addr)` → `{kind,type,networks,scriptPubKeyHex}` — **reuse this for any address handling** | `base58.cpp` |
| `txbuild.js` (617 L) | `serializeTx`, `planSpend`/`planMaxSpend`, `buildSignedSpendTx`, `buildSignedMintTx`, `buildSignedTransferTx`, `buildSignedRedeemTx`; `MIN_DD_TX_FEE_SATS = 0.1 DGB`, `MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100` | `digidollar/txbuilder.cpp` |
| `hd.js` | `HD_NETWORKS` (mainnet dgb/20, testnet dgbt/1, regtest dgbrt/1), mnemonic gen/validate/seed, `deriveTaprootAddress` (BIP86), `p2wpkhAddress` | — |
| `bip21.js` | `encodeBip21`/`parseBip21` (`digibyte:` URIs; canonical decimal, Android-interop) | Android `DigiByteUri.kt` |

Mint vout layout (documented in txbuild.js): `[0]` collateral P2TR (NUMS+MAST), `[1]` DD
token P2TR (0 value), `[2]` OP_RETURN, `[3]` P2WPKH change (omitted when dust — consensus
classifies by shape, not index). `unlockHeight = nextHeight + 100 + tier.lockBlocks`.
`address.js` rejects whitespace deliberately (Core's DecodeBase58 silently strips it).

**The flexible DGB leg** (transfer/redeem fee, mint funding). Consensus binds only the DD
token legs and the collateral to the owner key; the plain DGB input can be any coin the
wallet can sign, key-path P2TR **or** P2WPKH. Source, not fixtures, for the general rule:
`ValidateTransferTransaction` (`digidollar/validation.cpp:1644`) gates every input rule on
`coin.out.nValue == 0`, so a **non-zero-value** input is unconstrained in script type and
key. Captured evidence covers redeem and mint only — `redeem-tx.json` vin[3] and
`mint-tx.json` vin[0] are `[DER, pubkey]` v0 stacks; this repo's `transfer-tx.json` vin[1]
is a `[64]` key-path P2TR leg, so no fixture captures a v0 leg on a transfer.
Params (all additive, defaults reproduce the previous single-key anatomy byte-for-byte):

- `buildSignedTransferTx` / `buildSignedRedeemTx`: `feePrivKeyHex` (default `privKeyHex`)
  and `feeUtxo.type: 'p2wpkh'` → BIP-143 ECDSA instead of BIP-341 schnorr.
- `buildSignedMintTx`: `utxo.type: 'p2wpkh'` — the funding sighash commits to the funding
  script, so shape and signing path are chosen together (`dgbLegScriptHex`/`signDgbLeg`).
- `dgbChangeScriptHex` default is **unchanged**: the sender/owner's P2WPKH, never the
  borrowed fee key's. Both wallet call sites pass it explicitly anyway.
- The redeem fee leg is at index `1 + ddUtxos.length`, asserted — not "the last input".
- No DD fee bump for the heavier v0 witness: the leg costs ≤ 42 wu more
  (`P2WPKH_INPUT_WU` 272 vs `P2TR_INPUT_WU` 230) and the flat 0.1 DGB
  `MIN_DD_TX_FEE_SATS` floor is >100× the whole transaction's relay minimum. Pinned in
  `txbuild.test.js`. Plain spends already price per input type in `planSpend`.
- A **cross-key P2TR** fee leg is shape-invisible: bare 64-byte witness, no pubkey on the
  wire, identical tx body whichever key signed. Verify it by signature —
  `keyPathSighashForTest` (test seam in `txbuild.js`, **not** re-exported from `index.js`;
  deep-import it like `hd.test.js` does) + `schnorr.verify` against
  `ddTokenOutputKey(xOnlyPubKey(key))`, positive and negative. Proven: breaking only the
  P2TR branch of `dgbLegScriptHex`/`signDgbLeg` fails those two tests and nothing else.

## Test layers (differential harness)

1. **Offline fixture differential** (always run, `npm test`): rebuilds Core-built txs from
   `test/fixtures/*.json` (raw `getrawtransaction` dumps) **byte-for-byte** — transfer
   `9b3069da…`, redeem `b834557b…`, spend `496dda24…`. `spend.test.js` has its own
   independent segwit parser + hand-computed BIP-141 weights so assertions don't lean on
   `serializeTx`.
2. **Live regtest differential**: `scripts/regtest-stand.sh` (satoshi-for-satoshi collateral
   check vs Core's `mintdigidollar`) + five `e2e-*.test.js` suites, **skipped unless
   `DD_E2E_RPC` is set** (that's the standing "8 skipped" in test output — not a problem).
   Recipe: `DGB_BIN=… ./scripts/regtest-stand.sh --keep` then
   `DD_E2E_RPC=http://dd:ddpass@127.0.0.1:18500 npm test`.
3. **Pinned protocol vectors** for sign-to-derive live in `apps/wallet/test/connect.test.js`
   (not this package; **lands with #130** — on branch `build/connect-wallet-130` until
   merged): frozen 321-byte message + SHA-256, RFC-6979 signature for fixed key `32×0x07`,
   resulting mnemonic + fingerprint. Consensus-grade — a red pin is an incident, never re-pin.

## Rules

- Keep it pure: no fetch, no fs, no Date.now in library code.
- Any new tx shape goes through the differential harness before it can ship (ADR-0001/0002).
- Fee/weight changes: update the hand-computed expectations in `spend.test.js`, don't derive
  them from the implementation.

## See also

- Fork-validation findings + upstreaming map (single-coin fee stranding — `txbuild.js:243`/
  `:340` bind the fee coin to the owner's P2TR): `docs/discovery/dgbclick-fork-validation.md`
  — several findings addressed by PRs #165–#169.
