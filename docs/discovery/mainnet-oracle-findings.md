# Mainnet oracle: who feeds the price (#52)

Research against the DigiByte Core checkout (`develop` branch, DigiDollar V1 merge
`6dcc1bf0ff`; treat file:line refs as that revision — re-verify against the shipping
v9.26.4 tag before quoting externally). Answers issue #52's question: on mainnet,
who signs/publishes the attested DGB/USD price, and what must our stack run?

## Verdict — what we must run vs. what the network provides

**The network provides the price. We run nothing oracle-related on mainnet.**

- The consensus DGB/USD price is produced by a **fixed roster of 35 oracle
  operators (7-of-35 MuSig2 quorum)** whose x-only pubkeys are hard-coded in
  chainparams. They coordinate off-chain, and the block producer embeds the
  aggregate-signed bundle **in the coinbase** as an `OP_RETURN OP_ORACLE`
  (v0x03) output. Any synced full node reads the price deterministically from
  blocks; mint/redeem blocks without a valid fresh bundle are consensus-invalid.
- **`deploy/oracle-price-feeder.mjs` must NOT run against the mainnet node.**
  It drives `enablemockoracle`/`setmockoracleprice`, which are **regtest-only**
  RPCs (gated by `ChainType::REGTEST` throughout `src/rpc/digidollar.cpp`); on
  mainnet/testnet they don't exist.
- **Where the wallet's mainnet price data comes from — two paths, same source:**
  (1) the wallet UI calls `rpc('getoracleprice')` through the server's
  allow-listed `/api/rpc` proxy (quote/mint flows and the header price in
  `apps/wallet/public/app.js`); (2) the **`/api/price-history` chart** is fed by
  `startPriceSampler` in `apps/wallet/server.js`, which polls the same
  `getoracleprice` every 60 s into a persisted 24 h series. Both terminate at
  the synced node's bundle-manager cache — no external feed anywhere.
- **We cannot become a price feeder even if we wanted to**: `startoracle` only
  produces messages peers accept if our key matches one of the 35 chainparams
  roster slots (`net_processing.cpp` rejects non-roster signatures with
  `Misbehaving`). Joining the roster requires a chainparams change + coordinated
  release.
- **Operational requirement**: the backing mainnet `digibyted` must stay synced.
  If its oracle data goes stale (>1 h), `getoracleprice` returns 0/stale and the
  wallet must fail closed on mint quotes — the sampler's `price_micro_usd > 0`
  skip and the wallet's `is_stale` gate already handle this.

## How it works (consensus mechanics)

- **Price in the block, not from RPC/P2P**: `ConnectBlock` extracts
  `median_price_micro_usd` from the coinbase bundle and feeds it to DD tx
  validation (`src/validation.cpp:3110-3126`, `:3228`). During block validation
  the node refuses to fall back to any local/P2P cache — "Block validation must
  be deterministic across peers" (`validation.cpp:2081-2098`). The P2P-gossiped
  price is advisory (mempool path only).
- **Keys & quorum**: mainnet `nOraclePubkeyCount=35`,
  `nOracleConsensusRequired=7` (`src/kernel/chainparams.cpp:339-340`); the 35
  mainnet x-only keys at `chainparams.cpp:344-380` (labelled "launch roster" /
  "RC46"), oracle node endpoints `oracleN.digidollar.org:12024`
  (`chainparams.cpp:391-434`). Testnet uses a **different** 35-key set and
  `oracleN.digibyte.io:12033` endpoints.
- **Freshness**: bundle timestamp must be within `ORACLE_MAX_AGE_SECONDS = 3600`
  of the block time (reject `bad-oracle-timestamp`), and ≤60 s in the future.
  Epochs: mainnet `nOracleEpochLength = 40` blocks (~10 min), update interval 4
  blocks (~1 min).
- **Absent price**: a block containing a mint or redeem with no (or malformed,
  or non-MuSig2) oracle output is rejected (`bad-oracle-missing` /
  `bad-oracle-malformed` / `bad-oracle-musig2`,
  `src/oracle/bundle_manager.cpp:2228-2284`). Pure DD **transfers** are
  price-independent and need no bundle. During IBD/catch-up, oracle validation
  of historical blocks is skipped (prices were valid when mined).
- **Price bounds**: `ORACLE_MIN_PRICE_MICRO_USD = 100` ($0.0001) to
  `ORACLE_MAX_PRICE_MICRO_USD = 100000000` ($100) — `src/primitives/oracle.h:23-24`.
  **Sub-cent DGB prices are valid.** The legacy cents-scaled helpers
  (`ValidateOraclePrice`, `ValidateOraclePriceForTx`) with narrower ranges are
  not on the block-consensus path (see the corrected note in
  `mainnet-consensus-facts.md`).
- **RPC surface**: `getoracleprice` returns `price_micro_usd`, staleness,
  oracle count, 24 h high/low, volatility — sourced from the bundle manager's
  cache, which is only updated after full block validation (miner cache-poisoning
  defense). `getoracles`/`getoraclesigners`/`getalloracleprices` for
  introspection. `sendoracleprice` was removed as a security hole.

## What this means per launch-map issue

- **#52 (this issue)**: answered — network-provided price, nothing to run. The
  only mainnet stack change: ensure the feeder container/service is absent from
  the mainnet compose profile (#64) and the sampler points at the mainnet node.
- **#56 (node prep)**: no oracle-specific config needed on the node; `digidollar=1`
  + txindex (already set) suffice. Sync freshness is the only oracle dependency.
- **#64 (dual-stack)**: per-network price-history files fed by per-network
  `getoracleprice` sampling; no feeder anywhere except regtest dev stacks.

## Unconfirmed / flags

- Core checkout is `develop`, not the v9.26.4 release tag — mainnet roster keys
  carry RC («release candidate») labels (block comment says RC44, individual
  keys RC46); re-verify the shipped keyset if it ever matters (it doesn't for
  our stack — we never verify oracle sigs ourselves).
- MuSig2 aggregate-signature verification internals (`oracle/musig2_*`) were not
  read line-by-line; quorum gating and call sites were confirmed.
