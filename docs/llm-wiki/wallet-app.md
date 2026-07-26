# apps/wallet

Verified: 2026-07-26 @ branch `audit/2026-07-26-external-audit` (external-audit changeset).

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
- Small pure modules: `netchrome.js` (per-chain banner/pill + `betaCapError`, cap $500/tx;
  `backupSkipAllowed` — mainnet/unknown chain seal the backup ceremony), `dderrors.js`
  (consensus reject → friendly copy; spend/conflict families + `isAlreadyBroadcast`),
  `dca.js` (multiplier → BigInt bps), `autolock.js` (default 5 min; **absent ≠ 0/"Never"**),
  `broadcastlog.js` (pre-broadcast journal + local txid + FAIL-AMBIGUOUS classifier),
  `nettimeout.js` (per-path fetch budgets > server's upstream budgets), `validate.js`
  (indexer JSON: strict for signer inputs, tolerant for display), `persistence.js`
  (storage.persist probe/request + `diginaut.hadVault` tombstone).
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
  `PRICE_HISTORY_FILE`, `EXPLORER_TX_URL`, `EXPECTED_CHAIN`; hardening (#H4/#M3):
  `TRUST_PROXY` (read last XFF element — set ONLY behind a controlled proxy; the TLS/dual
  overlays set it), `RATE_LIMIT_WINDOW_MS` + `RATE_LIMIT_{RPC,INDEXER,FAUCET}_PER_MIN`
  (0 = unlimited; indexer must stay in the thousands — money poll is (index+3)×6 reads/8s),
  `MAX_{RPC,FAUCET}_BODY_BYTES`, `HSTS` (TLS deployments only). Tests inject via
  `startServer(overrides)` incl. `now` for the rate-limit clock.
- Body caps → 413; fixed-window per-IP limits → 429 + retry-after, limiter runs BEFORE
  guard/body/upstream. `rateBucket()` must mirror the routing conditions exactly.

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
  8s) — deliberately not `setInterval`, so a stalled fetch can't stack or install an older
  price. (money + price chart were `setInterval` until #H1 converted them.) Every frontend
  fetch goes through `apiFetch` with a `nettimeout.js` budget; failures carry
  `err.transport = 'timeout'|'network'` — downstream code keys off the FLAG, never the copy.
  Price staleness: `PRICE_MAX_AGE_MS = 180s` demotes USD entry (and disarms Max).
- Broadcast path: `broadcastTx(hex, meta)` journals to `diginaut.broadcasts` BEFORE sending;
  ambiguous outcomes keep the record and surface the `#w-recovery` card (chain-scoped,
  survives lock/switch, netKnown-gated). A definite reject's message passes through
  UNMODIFIED (verify-honest-quotes pins this). Stale-tip warning rows (`w-*-c-stale`) are
  written at REVIEW time only — never re-read state in the `w-*-go` handlers (L6 property).
  Card row titles drop to `r.kind` while `vault.status !== 'unlocked'` (amount + counterparty
  must not outlive the lock) — `show()` re-renders the card so it flips on the transition.
- **Cross-module copy contract**: `SERVER_REFUSALS` in `broadcastlog.js` string-matches the
  proxy's own 413/`request body too large` and 429/`too many requests — ` (the only refusals
  it cannot detect structurally). `server.test.js` feeds the live response through
  `classifyBroadcastError`, so rewording either message fails there instead of silently
  reclassifying a refused broadcast as ambiguous. Reword both sides together.

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

## Backup & browser storage (external audit, branch `audit/2026-07-26-external-audit`)

- `public/persistence.js` — pure, deps-injected (StorageManager + Storage), node-testable:
  `readPersistence` (**never** prompts — the boot probe) vs `ensurePersistence` (may prompt —
  only from a gesture: vault create, unlock), `persistenceCopy` → `{level,label,detail}`
  mapping onto `.dot.good/.bad/.warn`, and the tombstone helpers over
  `HAD_VAULT_KEY = 'diginaut.hadVault'`. Never `await` `probePersistence({request:true})` on a
  create/unlock path — a denied or slow browser prompt would freeze `busy()` (#C2).
- **localStorage keys are now three**: `diginaut.autolock`, `diginaut-mainnet-ack`,
  `diginaut.hadVault`. The tombstone is written wherever a vault exists (create, add-wallet,
  unlock, boot-with-vault) and cleared by **exactly two** deliberate erase paths —
  `w-erase-go` and last-wallet removal — always **before** `show('none')`. It must NOT be
  cleared by `vault.js`'s v1→v2 `deleteKeystore()`: a vault still exists there. Tombstone +
  no vault ⇒ the guest hero swaps `#hero-guest-copy` for `#hero-recovery` and the CTA reads
  "Restore a wallet" (keyed on `state === 'none'` only — the same hero also serves `locked`).
- Backup strip escalates on `persistState?.persisted !== true` (unknown counts as evictable),
  so it now nags at **zero balance**; the per-session dismiss is what keeps that bearable.
- `backupSkipAllowed(chain)` in `netchrome.js` is an **allow-list** (`test`/`testnet`/
  `regtest`) — mainnet *and an unknown chain* fail strict, the inverse of `betaCapError`'s
  warn-allow. Always gate on `gateChain()` (`netKnown ? netName : null`), never
  `chainState.netName` — that defaults to the string `'testnet'`.
- Sealing the ceremony means all three dismiss routes: `#w-backup-done`, `#w-modal-close`,
  backdrop. `closeConnectModal()` itself stays **unguarded** (lock/switch/autolock teardown);
  the guard lives in `requestCloseConnectModal()`. Only the create-time ceremony is
  `mandatory` — re-entry stays dismissible. `renderBackupSkipGate()` re-runs when the node
  names its chain, so a slow node does not permanently seal a testnet ceremony.
- `onModalClosed` tears down **every** draft (send **and** transfer, mint, consolidate) —
  each holds per-UTXO private keys and an armed confirm screen; `act-send`/`act-mint`/
  `dd-mint-open` also reset before opening (#L3).
- `?autolockSecs=` requires `appConfig.loaded && appConfig.mock` and is capped at 600 s —
  `appConfig.mock` defaults to `true` before `/api/config` answers, so the bare check failed
  open on a live deployment with a flaky config fetch (#L10).

## Tests

15 unit suites (192 tests) under `test/`, `npm test` — server (CSP/allow-list/proxy/price/
guard/rate-limits/HSTS/CRLF-hash), vault, vendor-integrity, keystore, netchrome (incl.
`backupSkipAllowed`), dderrors (incl. spend/conflict families), dca, autolock, connect
(protocol pins), broadcastlog (txid vs Core fixtures, classifier), nettimeout, validate
(strict/tolerant + MAX_MONEY drift pin), persistence, backup-roundtrip (M2: real WebCrypto
export→wipe→restore), driver-paths (Windows-path idiom must never return).
Baselines drift — run and compare. Drivers: see testing-and-drivers.md.
