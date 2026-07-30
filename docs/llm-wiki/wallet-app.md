# apps/wallet

Verified: 2026-07-31 @ branch `feat/diginaut-space-domain` (#138 icon system + connect modal,
the CTA/recovery/banner copy pass, then the diginaut.space domain switch).

## Layout

- `server.js` (~800 L) — zero-dep Node HTTP server: static host for `public/`, `/lib/`
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
  `backupSkipAllowed` — mainnet/unknown chain seal the backup ceremony; `foldNetHealth` —
  the header dot's failed-poll debounce), `dderrors.js`
  (consensus reject → friendly copy; spend/conflict families + `isAlreadyBroadcast`),
  `dca.js` (multiplier → BigInt bps), `autolock.js` (default 5 min; **absent ≠ 0/"Never"**),
  `broadcastlog.js` (pre-broadcast journal + local txid + FAIL-AMBIGUOUS classifier +
  `isTxUnknownToIndexer`, the "Check status" verdict),
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
- **Error bodies**: the indexer/faucet proxy failures and the catch-all 500 answer
  `{error, cause}` with the upstream detail logged (`console.error('wallet: …')`), never
  relayed — `err.message` there named INDEXER_URL/FAUCET_URL host:port. Causes:
  `indexer-unreachable`, `faucet-unreachable`, `internal`.
  **`handleRpc`'s 502 is the deliberate exception and must stay verbatim** — `broadcastlog.js`
  `classifyBroadcastError` string-matches the node's reject tokens, so genericizing it turns
  every definite reject into "may have been broadcast" (money-safety, #H3). The node's address
  is already public in `/api/config.rpcUrl`, so nothing new leaks. Pinned by a test.
- **Static caching** (`serveFrom`): `cache-control: no-cache` + a content-hash ETag (sha256 of
  the bytes, base64url, 27 chars) on EVERY static path incl. `/lib` and `/vendor`;
  `if-none-match` → 304. Before this there was no validator at all, so browsers applied
  heuristic freshness and phones ran days-old `app.js` after a deploy (index.html has no
  cache-busting, `deploy/Caddyfile` is a bare `reverse_proxy` — this is the only lever).
  Content hash, not mtime: Docker COPY preserves build-context mtimes, so a rollback could
  serve stale-but-plausible.

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
- **Who retries, and on what.** `fetchIndexer` alone: `[500, 1000, 2000]` ms, and what counts
  as transient lives in ONE predicate, `transientIndexerFailure` (nettimeout.js) — `err.transport`
  (dead browser↔wallet-server hop) **or** the wallet server's own 502 relay of a dead indexer
  hop, which is the deploy-restart shape and arrives as a normal response. That relay is matched
  by both its message (`indexer unreachable`) and a `cause: 'indexer-unreachable'` body token, so
  it survives either merge order with the indexer error contract. A 4xx, the 503 "no indexer
  configured" or an `INDEXER_SHAPES` refusal rethrows on the first attempt. Two caps: the FULL
  ladder is the first load's budget only (`indexerFirstLoad` clears at the first money paint) —
  after that one retry, because `refreshMoney` fans out to (index+3)×6 reads per tick — and
  `INDEXER_RETRY_BUDGET_MS` (10 s, < one hop's 20 s timeout) bounds the retries by wall clock, so
  a HUNG hop surfaces in ~one timeout instead of stacking four. `rpc()` must **never** grow a
  ladder: `broadcastTx` rides it, and a re-sent `sendrawtransaction` is the #C1 double-send.
- Header dot: `foldNetHealth` (netchrome.js) needs TWO consecutive FAILED polls before
  `netHealth.dd`/`.oracle` goes false — a ~2-3 s deploy restart used to paint it red. Only
  failures are debounced; an answered inactive/stale lands on the first tick, because these
  flags also gate `priceUsable`. Cost: a real outage reaches the dot up to one poll (60 s) late.
- Activity badge: the tx's own confirmation count outranks the address-history height (separate
  subsystems — the index lags, see `indexerLagBlocks`), but `final` needs BOTH (count ≥
  `FINAL_CONF` **and** `h.height > 0`), and `c === 0` is `pending` whatever the height says.
  Only a MISSING count falls back to height alone — which is also why the thin, un-enriched row
  still decides on height. Copy rule: `design-system.md`. Fixtures: `verify-history`.
- Broadcast path: `broadcastTx(hex, meta)` journals to `diginaut.broadcasts` BEFORE sending;
  ambiguous outcomes keep the record and surface the `#w-recovery` card (chain-scoped,
  survives lock/switch, netKnown-gated). A definite reject's message passes through
  UNMODIFIED (verify-honest-quotes pins this). Stale-tip warning rows (`w-*-c-stale`) are
  written at REVIEW time only — never re-read state in the `w-*-go` handlers (L6 property).
  Card row titles drop to `r.kind` while `vault.status !== 'unlocked'` (amount + counterparty
  must not outlive the lock) — `show()` re-renders the card so it flips on the transition.
  The row's last button is labelled from `rec`: a **live** row says *Delete saved transaction*
  (the click is `broadcastLog.drop()`, which destroys the signed hex that Rebroadcast and Copy
  raw transaction are the only users of, for a tx that may be in flight), a **resolved** row —
  `rec === null`, record already gone — says *Dismiss*, which is then true. Don't collapse the
  two back into one word.
- **"Check status" verdict**: the card's `recCheck` handler asks `/api/indexer/tx/:txid`, and
  `isTxUnknownToIndexer(err)` (broadcastlog.js) decides whether the answer earns *"never
  reached the network — Rebroadcast is safe"*. It reads the **`cause` token first**
  (`tx-not-found`; any other token is an outage and keeps the record) and only falls back to
  the old relayed text for a server that predates the token. A copy-only match is what broke
  it once already: the indexer's unknown-txid answer moved from ElectrumX's
  `No such mempool or blockchain transaction…` to `404 not found`, and the verdict went
  unreachable with no test to notice.
- **Cross-module copy contract**: `SERVER_REFUSALS` in `broadcastlog.js` string-matches the
  proxy's own 413/`request body too large` and 429/`too many requests — ` (the only refusals
  it cannot detect structurally). `server.test.js` feeds the live response through
  `classifyBroadcastError`, so rewording either message fails there instead of silently
  reclassifying a refused broadcast as ambiguous. Reword both sides together.

## Sign-to-derive (branch #130)

- **Four frozen messages, two axes** (ADR-0005 network × ADR-0006 origin era): v1 testnet /
  v2 mainnet on the `ludere.space` hosts, v3 testnet (333 B, `be8ffbacb1…`) / v4 mainnet
  (317 B, `51b9fe9bce…`) everywhere else. `s2dForChain(chain, hostname)` picks the pair by
  **serving hostname** — `LEGACY_S2D_HOSTS` is an allow-list and is **permanent**: drop a host
  and that origin keeps its old vaults while deriving different wallets, silently. Unknown
  hostname → the NEW era (a self-host on v1 would pin an origin it isn't); unknown chain →
  that era's TESTNET message. `s2dForVersion()` maps 1–4 for reconnect; unknown/absent → v1.
- **Reconnect is provenance-scoped, first derive is context-scoped.** `deriveOnce` gets
  `known.source.msgVersion` — the bytes that MADE the wallet — never `s2dForChain(...)`, which
  answers "which bytes would a new wallet use here". They agreed while a host's era was fixed
  forever; ADR-0006 moves it for every non-legacy host, so a pre-move v1 source would have been
  re-derived against v3, missed its fingerprint, and shown `showWeb3Mismatch` — accusing the
  *extension* of drifting for a change the app made. The network axis is deliberately not
  re-read either: "a testnet wallet finds nothing on mainnet" is enforced by `findSource` over
  an origin-scoped vault, and re-picking by chain resurrects the same false accusation on any
  origin whose node changes chain. `verify-connect-derive` §7 covers it.
- `LEGACY_S2D_HOSTS` (era allow-list) and `LEGACY_HOST_MOVED_TO` (host → canonical origin, for
  the move notice) both live in `connect.js`; the move targets are read out of the era-2
  messages' `Origin:` lines and a unit test pins the key sets equal both ways.
- `s2dOriginHost(message)` reads the host out of the message's `Origin:` line. The ceremony
  checkbox (`#w-web3-origin`, filled by `armWeb3Disclosure()` before the step is displayed) is
  the only consumer — it was a hardcoded `dgb.ludere.space`, so the **mainnet** ceremony told
  users the **testnet** domain was the only site allowed to ask. Never re-hardcode a host there.
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
- **localStorage keys are now four**: `diginaut.autolock`, `diginaut-mainnet-ack`,
  `diginaut.hadVault`, `diginaut.movedNotice` (the legacy-host "we've moved" strip, `#w-move-note`
  — shown only on the two `LEGACY_S2D_HOSTS`, dismissal is a UI preference so it lives here and
  **not** in the vault: it must apply before any vault exists and survive erase-all).
  The tombstone is written wherever a vault exists (create, add-wallet,
  unlock, boot-with-vault) and cleared by **exactly two** deliberate erase paths —
  `w-erase-go` and last-wallet removal — always **before** `show('none')`. It must NOT be
  cleared by `vault.js`'s v1→v2 `deleteKeystore()`: a vault still exists there. Tombstone +
  no vault ⇒ the guest hero swaps `#hero-guest-copy` for `#hero-recovery` and the CTA reads
  "Restore a wallet" (keyed on `state === 'none'` only — the same hero also serves `locked`,
  which takes the *Unlock* CTA; see § Connect modal for the three-state tuple).
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
- **`pickDgbCoin(utxos, minSats, preferKeyHex)` picks the DGB side of every DigiDollar
  transaction** — lives in `public/coinpick.js` (pinned by `test/coinpick.test.js`; inline
  in app.js an inverted tier order or a largest-first sort passed every suite in the repo)
  — the transfer/redeem fee and the mint's whole funding. Tiers: preferred-key
  P2TR → any wallet P2TR → any P2WPKH twin, smallest sufficient coin first. The old gates
  demanded a same-key P2TR coin, which the mint's own P2WPKH change could never satisfy — a
  wallet that minted with its only coin dead-ended. `buildSignedTransferTx`/`buildSignedRedeemTx`
  now get `feePrivKeyHex` + `feeUtxo.type`; `buildSignedMintTx` gets `utxo.type`.
- **Both DD fee errors are wallet-wide now.** They no longer name an address to top up;
  fragmentation (total ≥ fee, no single coin) keeps the `fragmentationError` flag that reveals
  the Consolidate offer, and a genuine shortfall is a plain error. Consequence: the offer can
  only appear with **two or more** coins, so the consolidate modal's single-coin guard
  (`spendable.length === 1`) is now defensive — a lone coin is never worth merging, whatever
  its type or address. Both gates total **confirmed, positive-value** coins only (`height > 0
  && valueSats > 0n`) — the same set `openConsolidateModal` plans over, so the offer they
  point at can always act, and value-0 DD tokens (`/utxos` is unfiltered) are not counted as
  DGB. The shortfall arm prints the holding through `satsToDgb`, not `fmtSats`: at 2 decimals
  a 0.119 DGB balance rendered as "you hold 0.12 DGB" — the fee — over a refusal.
- `onModalClosed` tears down **every** draft (send **and** transfer, mint, consolidate) —
  each holds per-UTXO private keys and an armed confirm screen; `act-send`/`act-mint`/
  `dd-mint-open` also reset before opening (#L3).
- `?autolockSecs=` requires `appConfig.loaded && appConfig.mock` and is capped at 600 s —
  `appConfig.mock` defaults to `true` before `/api/config` answers, so the bare check failed
  open on a live deployment with a flaky config fetch (#L10).

## Connect modal + icons (#138)

- `#w-choice` is four **doors** (`.door`), exactly ONE of them `.primary`. The old sheet
  painted create AND the EXPERIMENTAL web3 door solid black — two defaults, one risky. Never
  give a second door primary weight.
- Door ids are load-bearing: `w-create-choice` / `w-show-restore` / `w-show-import` /
  `w-web3-choice` are clicked **by id** in 13 drivers. Restyle freely, never rename.
- **The web3 door is on every network since 2026-07-27** (`#w-web3-group` no longer toggled by
  chain). Two things make that safe and both are load-bearing: the derivation bytes are
  per-network (**ADR 0005**; `s2dForChain` on first derive, `s2dForVersion` on reconnect), so a
  testnet-era signature can never be replayed against mainnet funds; and the mainnet save path
  runs the **sealed** ceremony — `w-web3-save-go` now calls
  `beginBackupCeremony(id, mnemonic, { mandatory: true })` when `!backupSkipAllowed(gateChain())`.
  That reverses #129's *"no forced reveal — the badge + strip carry the backup pressure"* **for
  mainnet only**; testnet keeps the light flow. #129 was decided while the door was testnet-only,
  where an unrecoverable wallet costs nothing. Do not "restore consistency" by deleting the seal:
  the failure mode is the extension changing how it signs (`showWeb3Mismatch`), and the 24 words
  are the only way back.
- **Ungating the door meant ungating TWO gates.** `#w-web3-group`'s display was only the visible
  one; `openWeb3Picker()` carried a second, functional refusal keyed on
  `chainState.netName === 'mainnet'`. Removing the first and leaving the second gives a door that
  renders and then refuses — caught by `verify-web3-mainnet`, not by review. That belt is now
  keyed on **`!chainState.netKnown`**, which is both the original boot-race intent and strictly
  safer: `s2dForChain()` falls back to v1 for an unknown chain, so a click landing before the
  chain poll resolves would derive the *testnet* wallet against a mainnet node — fundable, and
  never re-derivable from this door.
- **Never reach for a neighbour by DOM position.** `loadStatus()` gated the web3 door with
  `$('w-web3-choice').nextElementSibling` (the hint `<p>`). #138 folded that copy into the
  door, the walk hit `null`, the throw was swallowed by the surrounding `catch` — and took
  `maybeShowMainnetAck()` with it, so **mainnet served no risk interstitial**. Now one node,
  `#w-web3-group`. Caught only by `verify-mainnet-live` / `verify-beta-posture`, neither
  registered when this bit. `verify-beta-posture` **is registered since** (`run-drivers.sh`
  = 14, alongside `verify-mainnet-bringup`, which never touches the ack modal).
  `verify-mainnet-live` drives the **deployed** site (`argv[2]`, default
  `https://diginaut.space` since the domain switch; the legacy `https://diginaut.ludere.space`
  is still a valid target, 3-min node warm-up) and so stays out of the local gate —
  the blocking interstitial still has no coverage in `run-drivers.sh`. Don't read "14 green"
  as "mainnet ack is tested".
- Title is a state, not a constant: `setConnectMode()` → *Back up your seed phrase* / *Erase
  all wallets* / *Unlock your wallets* / *Add a wallet* (vault unlocked) / *Create or restore a
  wallet*. Writes `#w-connect-title` + `#w-connect-sub`; `querySelector('.modal-head h3')` is gone.
- **The hero CTA is a state too, and it should agree with the title it opens** — it does in
  every state but **wiped**, where the CTA reads *Restore a wallet* and the sheet still says
  *Create or restore a wallet* and focuses `w-create-choice`. That is the open deferral in
  `project-status.md` (the post-eviction sheet also still paints create as the sole
  `.door.primary`); fix the three together, not the title alone. `show()` picks
  all three from one tuple: `locked` → *Unlock* (chip *Unlock*), wiped → *Restore a wallet*
  (*Restore*), fresh → *Create or restore a wallet* (*Create or restore*). Both `#hero-connect`
  and the header chip `#w-connect` are written every `show()`, so the static HTML text is only
  the pre-first-render default. Before this, one constant "Connect wallet" rode all three —
  over a **locked** vault it offered to "connect" a wallet already on the device while opening
  a sheet titled *Unlock your wallets*. Add a state here and you must add its CTA.
- "Connect" now appears in exactly one place, `#w-web3-choice` (*Connect a browser wallet*),
  which is the only door where an external key holder really is granting access.
- `openConnectModal()` focuses inside a `requestAnimationFrame` (display flips in the same
  tick; an unlaid-out element cannot take focus) and **re-reads `vault.status` in the
  callback** — an autolock inside that frame would otherwise aim at a hidden door.
- Focus trap: `focusin` containment, since `aria-modal` claims the page is inert. Unlike the
  mainnet-ack trap it does **not** swallow Escape (this modal is dismissible) and snaps to the
  first *visible* control, because Close is hidden while a backup ceremony is sealed.
  `#mainnet-ack-modal` (role=`alertdialog`) is the only other trapped modal — `#disclaimer-modal`
  has none.
- **Driver gotcha, cost an hour:** every node here ships in the first paint, so
  `waitFor(getElementById('w-create-choice'))` returns *immediately*, the click lands mid-boot,
  and `show()` resets the mode under it. Wait on **visibility**, never presence.
- Icon sprite rules, the two visual tiers, and the `<svg>`-is-not-in-`textContent` trap:
  **`design-system.md`**.

## Tests

17 unit suites (**PENDING tests**, measured 2026-07-31 post-rebase) under `test/`, `npm test` — server (CSP/allow-list/proxy/price/
guard/rate-limits/HSTS/CRLF-hash/static-ETag), vault, vendor-integrity, keystore, netchrome
(incl. `backupSkipAllowed` + `foldNetHealth`), dderrors (incl. spend/conflict families), dca,
autolock, connect (protocol pins), broadcastlog (txid vs Core fixtures, classifier,
`isTxUnknownToIndexer`), icon-sprite, nettimeout, validate
(strict/tolerant + MAX_MONEY drift pin), persistence, backup-roundtrip (M2: real WebCrypto
export→wipe→restore), driver-paths (Windows-path idiom must never return).
Baselines drift — run and compare. Drivers: see testing-and-drivers.md.

## See also

- Fork-validation findings + upstreaming map (unbounded `kdf.iterations` in `parseKeystoreFile`;
  finality precedence in `historyRow`; `w-erase-go` leaving `diginaut.broadcasts` behind):
  `docs/discovery/dgbclick-fork-validation.md` — several findings addressed by PRs #165–#169.
