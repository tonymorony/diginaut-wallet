# packages/digidollar-js

Verified: 2026-07-26 @ `7247899`. ADR-0004: deterministic, zero I/O. All money is BigInt
(DGB in sats, DD in **cents**, oracle price in micro-USD/DGB). Deps pinned exactly:
`@noble/curves`, `@scure/bip32`, `@scure/bip39`. Consumed by wallet, indexer, faucet.

## Modules (entry: `src/index.js`, re-exports everything)

| Module | Exports (essentials) | Mirrors (Core v9.26.4) |
|---|---|---|
| `index.js` | `COIN`, `LOCK_TIERS` (10 tiers), `tierById`, `effectiveRatioPercent` (DCA ceiling), `requiredCollateralSats`, `DD_TX_LIMITS` (per-network; regtest 1–100k cents) | `consensus/digidollar.h`, `dca.cpp`, `txbuilder.cpp` |
| `envelope.js` | build/parse for DD nVersion marker (`0x0770`, type 1/2/3 = mint/transfer/redeem) + mint/transfer/redeem OP_RETURN metadata | `consensus/digidollar.cpp` |
| `taproot.js` | `ddTokenOutputKey` (key-path-only), `collateralOutputKey` (NUMS + 2-leaf MAST), redemption leaf + control block; `COLLATERAL_NUMS_KEY` | `digidollar/scripts.{h,cpp}` |
| `address.js` (324 L) | bech32/bech32m encode/decode, `scriptPubKeyFromAddress`, DD base58check `encodeDDAddress`/`decodeDDAddress`/`toDDAddress`, legacy decode, unified `decodeAddress(addr)` → `{kind,type,networks,scriptPubKeyHex}` — **reuse this for any address handling** | `base58.cpp` |
| `txbuild.js` (553 L) | `serializeTx`, `planSpend`/`planMaxSpend`, `buildSignedSpendTx`, `buildSignedMintTx`, `buildSignedTransferTx`, `buildSignedRedeemTx`; `MIN_DD_TX_FEE_SATS = 0.1 DGB`, `MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100` | `digidollar/txbuilder.cpp` |
| `hd.js` | `HD_NETWORKS` (mainnet dgb/20, testnet dgbt/1, regtest dgbrt/1), mnemonic gen/validate/seed, `deriveTaprootAddress` (BIP86), `p2wpkhAddress` | — |
| `bip21.js` | `encodeBip21`/`parseBip21` (`digibyte:` URIs; canonical decimal, Android-interop) | Android `DigiByteUri.kt` |

Mint vout layout (documented in txbuild.js): `[0]` collateral P2TR (NUMS+MAST), `[1]` DD
token P2TR (0 value), `[2]` OP_RETURN, `[3]` P2WPKH change (omitted when dust — consensus
classifies by shape, not index). `unlockHeight = nextHeight + 100 + tier.lockBlocks`.
`address.js` rejects whitespace deliberately (Core's DecodeBase58 silently strips it).

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
