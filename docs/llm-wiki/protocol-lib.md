# packages/digidollar-js

Verified: 2026-07-30 @ `1d5bc90`. ADR-0004: deterministic, zero I/O. All money is BigInt
(DGB in sats, DD in **cents**, oracle price in micro-USD/DGB). Deps pinned exactly:
`@noble/curves`, `@scure/bip32`, `@scure/bip39`. Consumed by wallet, indexer, faucet.

## Modules (entry: `src/index.js`)

`index.js` re-exports the PUBLIC surface, not everything. Deliberately module-level only
(import from `../src/txbuild.js`): `taprootSighash`, `signSighash`, `tapTweakPrivKey`,
`checkBuiltDDTx`, `assertBuiltDDTx`, `SIGHASH_*`, `OP_RETURN_RELAY_CAP_BYTES`,
`CHANGE_FOLD_SATS` — plus all of `tapscript.js` except `NUMS_KEY`.

| Module | Exports (essentials) | Mirrors (Core v9.26.4) |
|---|---|---|
| `index.js` | `COIN`, `LOCK_TIERS` (10 tiers), `tierById`, `effectiveRatioPercent` (DCA ceiling), `requiredCollateralSats`, `DD_TX_LIMITS` (per-network; regtest 1–100k cents) | `consensus/digidollar.h`, `dca.cpp`, `txbuilder.cpp` |
| `envelope.js` | build/parse for DD nVersion marker (`0x0770`, type 1/2/3 = mint/transfer/redeem) + mint/transfer/redeem OP_RETURN metadata | `consensus/digidollar.cpp` |
| `tapscript.js` (#148) | generic BIP-341: `NUMS_KEY`, `pushScriptNum`/`pushData`, `tapLeafHash`, `tapBranchHash`, `tapRootFromLeaves`, `tapOutputKey`, `controlBlockHex`. **Flat trees only** — 1 leaf (33-B control block) or 2 (65-B); ≥3 throws. Nested trees are not expressible | BIP-341 |
| `taproot.js` | `ddTokenOutputKey` (key-path-only), `collateralOutputKey` (NUMS + 2-leaf MAST), redemption leaf + control block; `COLLATERAL_NUMS_KEY` = `NUMS_KEY`. Now only the DD **leaf layouts** — the tagged-hash/tweak math moved to `tapscript.js` | `digidollar/scripts.{h,cpp}` |
| `bond.js` (#148) | Lock & Earn: `bondLeafHex`/`bondOutputKey`/`bondControlBlockHex` (single CLTV leaf under NUMS), `computeFloorShares`, `planDistributionChunks`, `buildSignedBondLockTx`/`…BondUnlockTx`/`…EscrowSplitTx`/`…DistributionTx`, `attachDistributionFee`, `verifyDistributionChunk`; `MAX_PAYOUTS_PER_CHUNK = 8`, `MAX_CHUNKS_PER_SPLIT = 8` (8×8 = 64 paid stakers/epoch), `MAX_ATTACHED_FEE_SATS = 0.5 DGB` | none — plain DD transfers |
| `address.js` (324 L) | bech32/bech32m encode/decode, `scriptPubKeyFromAddress`, DD base58check `encodeDDAddress`/`decodeDDAddress`/`toDDAddress`, legacy decode, unified `decodeAddress(addr)` → `{kind,type,networks,scriptPubKeyHex}` — **reuse this for any address handling** | `base58.cpp` |
| `txbuild.js` (924 L) | `serializeTx`, **`parseTx`** (its inverse), `planSpend`/`planMaxSpend`, `buildSignedSpendTx`, `buildSignedMintTx`, `buildSignedTransferTx`, `buildSignedRedeemTx`; `MIN_DD_TX_FEE_SATS = 0.1 DGB`, `MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100`, `MIN_DD_OUTPUT_CENTS = 100`, `MAX_DD_OUTPUT_CENTS = 10_000_000` ($100k/output, validation.cpp:1761), `OP_RETURN_RELAY_CAP_BYTES = 83` | `digidollar/txbuilder.cpp` |
| `hd.js` | `HD_NETWORKS` (mainnet dgb/20, testnet dgbt/1, regtest dgbrt/1), mnemonic gen/validate/seed, `deriveTaprootAddress` (BIP86), `p2wpkhAddress` | — |
| `bip21.js` | `encodeBip21`/`parseBip21` (`digibyte:` URIs; canonical decimal, Android-interop) | Android `DigiByteUri.kt` |

Mint vout layout (documented in txbuild.js): `[0]` collateral P2TR (NUMS+MAST), `[1]` DD
token P2TR (0 value), `[2]` OP_RETURN, `[3]` P2WPKH change (omitted when dust — consensus
classifies by shape, not index). `unlockHeight = nextHeight + 100 + tier.lockBlocks`.
`address.js` rejects whitespace deliberately (Core's DecodeBase58 silently strips it).
The OP_RETURN is **last only on a transfer**; mint and redeem put change after it.

## Verify-before-sign gate (#148, ADR-0002 machinery)

`checkBuiltDDTx({ txHex, expect })` → `{ ok, checks: [{ name, ok, detail }] }` re-derives a
DD transaction's meaning from its FINAL BYTES and compares it to the intent. Every DD
builder (mint/transfer/redeem + all four Lock & Earn shapes) ends with `assertBuiltDDTx`,
which throws — no hex escapes a failed check. `verifyDistributionChunk` runs the same core
over **received** bytes and returns the list instead (never throws on content).
Check names are stable strings the wallet will render: `parse`, `scriptsig-empty`,
`dd-marker`, `output-shapes`, `envelope-present`, `envelope-pairing`, `envelope-exact`,
`envelope-size`, `dd-minimum`, `dd-maximum`, `dd-conservation`, `dd-outputs-match`,
`valued-outputs-match`, `locktime`, `input-sequences`, plus the distribution's
`record-version`, `record-shape`, `input-count`, `escrow-prevout`, `sequence-non-final`,
`record-locktime`, `no-valued-output`, `payout-count`, `payout-sum`, `payouts-include`,
`acp-signature` — and `verifier-error`, which is how the never-throws contract is kept when
input does something unanticipated (a JSON-decoded record has Number cents, not BigInt).
`locktime` is always the parsed bytes; `record-locktime` is the record's own claim.

**What the gate does NOT check**: fee values (nothing here prices a transaction), witness
validity beyond the distribution's ACP signature (the other builders' signatures are not
re-verified after signing), and standardness beyond the envelope's 83-byte cap — no dust
policy, no tx-size or sigop limits, no mempool-acceptance judgement. It answers "do these
bytes mean what I asked for", not "will a node take them". Proving relay is #153's job.

Heights: `bondLeafHex` and `buildSignedDistributionTx` refuse any height >= **500,000,000**
(BIP-65 LOCKTIME_THRESHOLD). Above it CLTV compares a TIMESTAMP, so the lock is a no-op; at
>= 2^32 the leaf keeps a 5-byte CScriptNum while nLockTime truncates to uint32, and a bond
(single leaf, NUMS internal key, no key path) becomes **permanently unspendable**.

The **83-byte envelope cap can no longer be reached by legal amounts**: with the $100k
per-output maximum the fattest legal 8-payout envelope is 46 bytes (0x989680 sign-pads to 4
bytes + 1 length byte each, over a 6-byte header). The cap stays enforced in the planner and
the verifier as defence in depth — it bounds the encoded envelope rather than trusting that
arithmetic.

`DD_TX_LIMITS.regtest.minMintCents = 1n` has a **dead range below 100c**: a sub-$1 mint
passes mint-amount validation and is then rejected by OUTPUT validation
(validation.cpp:1092/1135 vs digidollar.h:73 `minOutputAmount = 100`, no regtest override).
The mint gate refuses it as `dd-minimum`. UNVERIFIED on a live node — prove it in #153.

Sighash hash types: `taprootSighash` accepts **0x00, 0x01, 0x81 only**; NONE/SINGLE and
their ACP forms throw by name (SINGLE|ACP's change-leak, `docs/discovery/dd-defi-yield.md`).
It, `signSighash` and `tapTweakPrivKey` are module-level exports for bond.js + the suite and
are deliberately **not** re-exported from `index.js` — a DD-marked signature must come out
of an audited builder that ran its gate.

**ESM cycle gotcha:** `index.js` ↔ `txbuild.js` is a real import cycle (txbuild.js reads the
lock tiers from index.js), and `hd.js` imports txbuild.js directly. A sibling module that
reads a txbuild.js binding **at module-evaluation time** hits the temporal dead zone
depending on which file the process imports first (`node --test test/hd.test.js` was the
entry that caught it). Keep module-level constants in new src files literal.

## Test layers (differential harness)

1. **Offline fixture differential** (always run, `npm test`): rebuilds Core-built txs from
   `test/fixtures/*.json` (raw `getrawtransaction` dumps) **byte-for-byte** — transfer
   `9b3069da…`, redeem `b834557b…`, spend `496dda24…`. The library now HAS a parser
   (`parseTx`), but the test-local parsers in `spend.test.js` / `bond.test.js` stay
   independent ON PURPOSE, together with hand-computed BIP-141 weights, so assertions never
   lean on the code under test. `parseTx` is separately checked against all three fixtures'
   node-decoded JSON and re-serialized back to the original hex.
2. **Upstream BIP-341 vectors** (`test/fixtures/bip341-wallet-vectors.json`, a verbatim copy
   of DigiByte Core v9.26.4 `src/test/data/bip341_wallet_vectors.json`): 12 leaf hashes,
   7 output-key tweaks, 4 flat merkle roots, 6 control blocks, and the three key-path
   sighash digests with hash types 0/1/0x81 (the other four hash types must throw). This is
   the independence anchor for `tapscript.js` and for `taprootSighash`. Its `rawUnsignedTx`
   is **legacy-serialized** — no segwit marker — which is why `parseTx` handles both layouts.
3. **Live regtest differential**: `scripts/regtest-stand.sh` (satoshi-for-satoshi collateral
   check vs Core's `mintdigidollar`) + five `e2e-*.test.js` suites, **skipped unless
   `DD_E2E_RPC` is set** (that's the standing "8 skipped" in test output — not a problem).
   Recipe: `DGB_BIN=… ./scripts/regtest-stand.sh --keep` then
   `DD_E2E_RPC=http://dd:ddpass@127.0.0.1:18500 npm test`.
4. **Pinned protocol vectors** for sign-to-derive live in `apps/wallet/test/connect.test.js`
   (not this package; **lands with #130** — on branch `build/connect-wallet-130` until
   merged): frozen 321-byte message + SHA-256, RFC-6979 signature for fixed key `32×0x07`,
   resulting mnemonic + fingerprint. Consensus-grade — a red pin is an incident, never re-pin.
5. **Pinned sighash digests** (`test/bond.test.js`, #148 — the first in this package).
   Product shapes with fixed synthetic keys (staker `32×0x07`, ephemeral `32×0x09`,
   unlockHeight 1060): script-path bond-unlock `0x00`
   `76e4f26c1584d0302d030d58bd8112693c71a32c748414960192ea34c798dafb`; key-path distribution
   `0x81` `4e917f40af2a0ee0568288edb5794b64c04adafed9942e0f766a6e174b792c78`. Each is computed
   twice — by `taprootSighash` and by a BIP-341 message constructor written inside the test —
   and the resulting signature is Schnorr-verified. Same rule: a red pin is an incident.
   `test/bond.test.js` also carries the **mutation battery**: 19 doctored chunks, each
   asserted to flip an exact set of named checks (the chunks are serialized and signed by the
   test itself, so they are doctored independently of `src/`).

## Rules

- Keep it pure: no fetch, no fs, no Date.now in library code.
- Any new tx shape goes through the differential harness before it can ship (ADR-0001/0002).
- Fee/weight changes: update the hand-computed expectations in `spend.test.js`, don't derive
  them from the implementation.
- A new DD tx shape needs a builder **inside** this package with its own post-build gate, not
  a raw signer in app code. That is the "around, not through" property the gate buys.
- Lock & Earn Layer 1–2 fixtures (real Core-accepted bond/escrow/distribution txs, regtest
  relay of the all-zero-valued-output shape) are **#153**, after #154 picks the venue.
  `computeFloorShares`' carry identity + sorted ordering and `MAX_ATTACHED_FEE_SATS` are
  marked PROVISIONAL pending the #146 grilling — a change is one line plus its fixtures.
