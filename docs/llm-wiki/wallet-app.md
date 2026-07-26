# apps/wallet

Verified: 2026-07-26 @ `7247899` (branch `build/connect-wallet-130`).

## Layout

- `server.js` (~530 L) — zero-dep Node HTTP server: static host for `public/`, `/lib/`
  (digidollar-js), `/vendor/` (crypto deps); `/api/rpc` allow-list proxy; `/api/indexer/*`
  (path regex-restricted); `/api/faucet/claim`; `/api/price-history`; `/api/config`.
  Owns CSP headers, vendor-integrity boot gate, cross-wire chain guard, price sampler,
  version stamping (`resolveVersion()`: semver + `.version-stamp` export-subst → git → dev).
- `public/index.html` (~1100 L) — single page, inline styles + CSP-hashed inline importmap
  (bare `@noble/@scure/qrcode-generator` specifiers → `/vendor/…`). All markup id-addressed
  (`w-*`, `m-*`); no framework, no build step.
- `public/app.js` (~3200 L) — the whole UI controller; every flow lives here.
- `public/vault.js` — `createVaultManager(storage)`: single source of truth for wallet meta +
  mnemonics; states `none/locked/unlocked`; storage injected (testable under node:test).
- `public/keystore.js` — PBKDF2-SHA256 600k → AES-256-GCM; keystore-file envelope
  (`diginaut-keystore` v1); IndexedDB (`dd-wallet`/`keystore`, records `primary` v1 + `vault`
  v2); `BroadcastChannel('diginaut-vault')` cross-tab sync; rev-CAS writes →
  `VaultConflictError`. Held key must always match `record.kdf.salt`.
- `public/connect.js` (~200 L) — sign-to-derive protocol + EIP-6963/Phantom plumbing (below).
- Small pure modules: `netchrome.js` (per-chain banner/pill + `betaCapError`, cap $500/tx),
  `dderrors.js` (consensus reject → friendly copy), `dca.js` (multiplier → BigInt bps),
  `autolock.js` (default 5 min; **absent ≠ 0/"Never"**).
- `vendor-integrity.js` + `vendor.lock` — see architecture.md invariant #2.

## Server facts

- `ALLOWED_METHODS` (`server.js:177`): getblockchaininfo, getdeploymentinfo, getoracleprice,
  getoracles, sendrawtransaction, getdcamultiplier, getprotectionstatus. Fund-moving RPCs
  deliberately excluded. Extending = allow-list + `mockResponse()` + tests, together.
- Mock mode = no RPC user/pass. `mockResponse()` returns real-shaped payloads (testnet, DD
  active, price 13,420 µUSD, 35 oracle slots; `MOCK_SYSTEM_HEALTH` env demos degraded DCA).
  Mock mode skips chain guard + price sampler and serves a synthetic price series.
- Cross-wire guard is fail-closed: with `EXPECTED_CHAIN` set, every RPC/indexer/faucet call
  refused until the node's chain is confirmed matching; UI hard-stops boot on mismatch.
- Env: `PORT` (8787), `DGB_RPC_URL/USER/PASS`, `FAUCET_URL`, `INDEXER_URL`,
  `PRICE_HISTORY_FILE`, `EXPLORER_TX_URL`, `EXPECTED_CHAIN`. Tests inject via
  `startServer(overrides)`.

## Client state (module-level in app.js)

- `chainState = {ddActive, netName, netKnown}` — netName is a **guess** until `netKnown`;
  nothing address- or network-scoped may run before it (netKnown gating).
- `wallet = {id, mnemonic, seed, index, network}` — secrets only while unlocked;
  `walletGen` monotonic counter guards async races: any async that paints money/addresses
  re-checks generation before touching the DOM (wallet-switch crosstalk, #122).
- `vault` manager API: load/refresh/unlock/lock/createVault/migrateV1/addWallet/rename/
  remove/setActive/setBackedUp/setReceiveIndex/getMnemonic/getSource/findSource/verifyPassword.
- `connectMode` step machine (choice/create/restore/import/unlock/erase/backup/quiz/
  backup-done/web3-pick/web3-sign) — every mode exit **wipes** the associated secret UI state.
- Send state: `sendCcy` ('DGB'|'USD') + `sendMaxArmed` — must be cleared by anything that
  abandons a draft (BIP21 absorb, switch, cancel) — #116.
- Polling: self-rescheduling `setTimeout` chains (status 5s→60s, oracle/DCA/chart 60s, money
  8s) — deliberately not `setInterval`, so a stalled fetch can't install an older price.
  Price staleness: `PRICE_MAX_AGE_MS = 180s` demotes USD entry (and disarms Max).

## Sign-to-derive (branch #130)

- `connect.js`: frozen `S2D_MESSAGE` v1 (321 bytes, testnet-scoped, origin-pinned);
  `canonicalizeEvmSignature` (strict 65-byte, low-s); `recoverEthAddress` (local ecrecover);
  `verifySolanaSignature` (zip215:false); entropy = SHA-256(canonical 64 bytes, v excluded) →
  24-word mnemonic (native wallets are 12-word — visible class marker) → BIP86;
  4-byte domain-tagged fingerprint; `discoverProviders` = EIP-6963 only, Phantom-EVM filtered
  out, no `window.ethereum` fallback; `deriveFromSource` double-signs, byte-compares, zeros
  signature buffers.
- Wallet-specific invariants (repo-level ones: architecture.md):
  - Protocol bytes are **consensus-grade**, pinned in `test/connect.test.js` — a diff there
    changes every user's derived wallet. Never re-pin to green.
  - Double-sign equality is the **only MPC detector** — never "optimize" to one signature.
  - Reconnect fingerprint mismatch = hard stop + explicit "save as NEW wallet" — never
    silent-swap.
  - Cleartext vault meta carries only `derived:true`; brand/address/fingerprint live in the
    encrypted secrets.
- CSP is derived from the real index.html importmap hash; changing the importmap fails loudly.
  No unsafe-inline; every `innerHTML` sink goes through `esc()`.

## Tests

9 unit suites (~101 tests) under `test/`, `npm test`: server (CSP/allow-list/proxy/price/
guard), vault (migration, CAS, receive-index), connect (protocol pins), vendor-integrity,
keystore, netchrome, dderrors, dca, autolock. Drivers: see testing-and-drivers.md.
