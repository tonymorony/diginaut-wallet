# Testing & drivers

Verified: 2026-07-31 @ branch `feat/diginaut-space-domain`. Baselines drift — run and
compare, don't quote stale counts.
Last known green: all **14** registered CDP drivers (`scripts/run-drivers.sh`, no args) + all
unit suites, 2026-07-27. (Was 11 until `verify-beta-posture` and `verify-mainnet-bringup` were
registered — both were self-contained but unwired, so no CI run had ever driven a
mainnet-shaped node; 14 since `verify-web3-mainnet`. Count the arrays in `run-drivers.sh`,
don't quote this line.)

**Two `visible()` traps this file keeps re-learning.** `visible(id)` is
`style.display !== 'none'`, so it is **true for any element that has never had an inline
display written** — `waitFor` returns instantly, the click lands mid-boot, and `show()` resets
the mode underneath it. `verify-web3-mainnet` hit it twice while being written: on
`#hero-connect` (settle on `visible('w-none')` instead — `show()` writes that one) and on
`#w-backup` after the save (wait on `#w-connect-title` reading *Back up your seed phrase*,
which `setConnectMode` writes). Rule: only `waitFor(visible(x))` when you have checked that
something writes `x.style.display`; otherwise wait on text a render function sets.
Regtest: 8 of the 9 drivers (98 checks) vs main, 2026-07-26 — `verify-fold-shapes` was proven
separately (PR #124), not part of that run.

## Layers

1. **Unit** — `npm test` (node:test, offline, fast) across all workspaces. digidollar-js
   shows "8 skipped" = the `DD_E2E_*`-gated e2e suites; expected offline.
2. **CDP drivers** — `apps/wallet/scripts/verify-*.mjs`: zero-dep headless-Chrome-over-CDP,
   exit 0 = green, PNG evidence written next to cwd. Runner: `scripts/run-drivers.sh
   [names…]` (CDP 9224, fresh profile per driver, reaps strays, temp cwd for screenshots).
3. **Regtest full-stack** — real Core consensus is the judge (testmempoolaccept / mining).
4. **Deployed smokes** — `verify-public.mjs`, `verify-dual-public.mjs`,
   `verify-mainnet-live.mjs` against live URLs.

## Driver catalog (what guards what)

- **Registered in `run-drivers.sh` = what CI runs.** SELF_CONTAINED: `verify-autolock-default`,
  `verify-crosswire`, `verify-wallet-mgmt`, `verify-receive-index`, `verify-receive-ui`,
  `verify-send-amount`, `verify-wallet-switch` (was the CI flake — **fixed 2026-07-27**, see
  gotchas), `verify-oracle-refresh`; branch #130 adds
  `verify-connect-derive` (sign-to-derive, **7** scenarios, fake EIP-6963 provider — §7 is the
  era-crossing reconnect: it mints a `msgVersion: 1` source through the app's own
  `connect.js` + `vault.js` over the real IndexedDB, because the pre-ADR-0006 build that would
  have left one cannot be run, then asserts the reconnect signs the **v1** bytes and matches.
  It waits on "settled either way" and then `check()`s which way, so a regression prints the
  diagnosis instead of dying on a 20 s `waitFor` timeout);
  `verify-web3-mainnet` (the same fake provider against a **mainnet-shaped** node — the
  combination neither of the other two covered). It guards the two properties that make the
  mainnet door safe, and guards them *positively*: the fake wallet **throws on any message but
  the v4 hex**, so a regression that sends the testnet (or a legacy-era) message fails the
  ceremony instead of silently deriving the wrong wallet on real funds; and it asserts the save
  path opens the **sealed** ceremony (`w-backup-sealed` shown, `w-backup-done` and
  `w-modal-close` both hidden) and that the seed it reveals is the v4-derived one, not v3.
  **Both web3 drivers run against 127.0.0.1, which is the NEW origin era** (ADR-0006) — the
  live bytes there are v3/v4, and `eip191Digest()`'s bare default is still the **v1** message,
  so a fake provider that takes the default gets rejected with "unexpected message bytes".
  NEEDS_STACK (runner starts fake-indexer 8799 + wallet 8791): `verify-ui`
  (create/lock/unlock/restore), `verify-receive-compat`.
- **Manual mock/stub drivers — NOT in the runner or CI, run them by name when touching
  their area**: `verify-honest-quotes` (MOCK_SYSTEM_HEALTH), `verify-oracle-bounds`,
  `verify-history`, `verify-fiat-sendmax`, `verify-disclaimer`.
  `verify-history` (17 checks) also owns the confirmation-badge precedence: its inline fake
  serves a tx at index height 0 with 24 node confirmations (must read `24 conf`, never
  `pending`) and one claiming 9999 the index has no block for (must stay `9999 conf`, never
  `final`). Both assert the badge's EXACT `class|text` — the tick is an `<svg>`, so text alone
  cannot prove a row did not claim finality, and a `!/final/` test would also pass if the
  fixture row vanished (verified: renaming the row turns the check red).
  `verify-oracle-bounds` passes its 5 mint-gate checks and then **hangs on
  `timeout: wallet unlocked after reload`** under Chrome 150 — reproduced identically on
  `origin/main` (2026-07-31), so it is environmental, not a regression. Don't chase it from a
  branch; the 5 checks before it are the useful signal.
  (`verify-beta-posture` and `verify-mainnet-bringup` used to be listed here; both are
  REGISTERED in `run-drivers.sh` now and run in CI.)
- Regtest stack (manual, need the stand): `verify-balance`, `verify-send`, `verify-mint`,
  `verify-positions`, `verify-transfer`, `verify-redeem`, `verify-p2wpkh-change`,
  `verify-walkthrough` (release gate), `verify-fold-shapes` (#118 shapes via
  testmempoolaccept; fresh stand per run).
- **The flexible DGB leg rewrote three drivers' expectations** (branch `feat/flexible-fee-leg`).
  `verify-transfer` and `verify-redeem` used to assert "no DGB for the fee" after a mint and
  then top up with 1 DGB — that error encoded the bug. They now assert the mint's own P2WPKH
  change pays the fee, with no top-up. `verify-receive-compat`'s transfer variant needs a
  genuinely fragmented balance (two sub-fee coins) to reach the fee gate at all; a twin coin
  big enough is simply used. Those two regtest drivers are the **acceptance gate** for that
  change and **still have not been run** (no regtest stand available on this machine) —
  treat them as the pre-merge gate, not as passed.
  Two gate assertions were fixed after review and are also unrun: `verify-transfer.mjs`
  and `verify-redeem.mjs` now assert `utxos.every((u) => BigInt(u.valueSats) === 0n)` for
  the post-mint address, not `utxos.length === 0`. **`/api/address/:addr/utxos` is
  unfiltered** (it maps `listunspent` straight through, which is what lets `/dd-utxos`
  find DD tokens), and a mint's vout[1] is byte-identical to the owner's own receive
  address — so that address always still holds exactly one value-0 output, the DD token,
  and `length === 0` could never hold. `verify-walkthrough` lost its addrA top-up and the
  `send at least … DGB to (\w+)` recovery branch (that string no longer exists in app.js);
  `verify-mint` now checks the fragmented-mint error for `Consolidate coins below`, the
  wording all three DD fee/funding gates share.

## Running the full local regtest stack on this Mac (proven recipe)

1. Node binary: macOS DigiByte-Qt **embeds** the full node —
   `DGB_BIN="…/DigiByte-Qt.app/Contents/MacOS/DigiByte-Qt" ./scripts/regtest-stand.sh --keep`
   (~7–10 min to "stand complete"). ElectrumX cannot run natively (Homebrew leveldb lacks
   RTTI) — run it in Docker: `scripts/electrumx-regtest/run.sh` with
   `DAEMON_URL=http://dd:ddpass@host.docker.internal:18500`.
2. Then plain-Node services: indexer 8789 (`DGB_HRP=dgbrt ELECTRUM_PORT=50001`), faucet 8790
   (`DGB_RPC_WALLET=stand`), wallet 8791; Chrome CDP 9224.
3. ElectrumX readiness = its own log line `synced to height N`. A TCP probe on 50001
   succeeds long before that — NOT a readiness signal.

## Gotchas (each cost real time — check before debugging "failures")

- **Fresh Chrome `--user-data-dir` per run** — IndexedDB keeps the vault; a reused profile
  boots `locked` and the driver times out.
- **Fresh stand per regtest-driver run** when the driver uses constant keys — a re-mint to an
  already-seen DD scriptPubKey gets `dd-input-amounts-unknown` on transfer/redeem
  (self-collision, not a consensus failure).
- **Port squatters**: a stale process bound to `127.0.0.1:<port>` beats a new wildcard bind
  for loopback. `lsof -nP -iTCP:<port> -sTCP:LISTEN` on EVERY stack port before trusting a
  run — look for TWO listeners. Crashed drivers leave fake-indexers holding ports →
  `pkill` fake-indexer/server between runs (run-drivers.sh does this).
- **Faucet is one-claim-per-IP-per-24h** — a second driver in the same stack silently never
  gets funded; restart the faucet with a fresh `FAUCET_DATA_FILE` before each driver.
- **Stub indexer tips must equal the mock node's `blocks` (`1_284_512`, server.js
  `getblockchaininfo`)** or the #H5 stale-index warning fires on every confirm screen and
  poisons screenshots + confirm-screen assertions. `fake-indexer.mjs` defaults to it; inline
  fixtures (`verify-beta-posture`, `verify-history`, `verify-honest-quotes`) hard-code it;
  `verify-oracle-bounds` uses its own `HEIGHT` on both sides.
- `fake-indexer.mjs` control endpoints: `/__fund`, `/__reset`, `/__fail`, and `/__tip`
  (`{"tip":N}`, moves the served tipHeight at runtime). The warning is written at REVIEW
  time from the retained 8 s poll state, so after `/__tip` you must **re-review** until it
  flips — see `verify-send-amount.mjs` §C.
- Drivers print "Done." even with red checks — grep `❌`, never trust the tail.
- Never pipe a driver into grep (backgrounded Chrome holds the pipe; shell hangs) —
  redirect to a file, grep the file.
- A driver without explicit `process.exit(process.exitCode || 0)` hangs after "all green".
  The **mirror failure is worse and silent**: a bare `process.exit(0)` discards every red
  `check()`, and `run-drivers.sh` keys off the exit code — so the driver is registered in the
  gate while being structurally incapable of failing it. `verify-web3-mainnet` shipped that way
  (fixed 2026-07-31). Grep the drivers for `process.exit(0)` before trusting a green run.
- Local default Node may be too old for CDP drivers (needs global WebSocket, Node ≥22) —
  use the nvm Node 24 binary.
- Start headless Chrome with `run_in_background` and **poll the CDP endpoint** before
  driving; a fixed 2 s sleep is not enough.
- Assert **intent**, never exact UI copy (see agent-workflow.md).
- The drivers' `click(id)` is `element.click()` over CDP, so it fires on a `display:none`
  element too. That is why the ~20 mock/testnet `w-backup-done` clicks survived the audit's
  mainnet skip gate (#C3) — visibility must be asserted explicitly, a passing click proves
  nothing about whether the button is on screen.
- **A funded wallet's receive address ROTATES on re-open** — `syncReceiveIndex` finds index 0
  used and advances. Any driver asserting "we are back on wallet X" via `w-address` equality
  is racing that bump: it passes only when the poll samples before the scan lands (fast
  machine → red, slower CI → green). That was the whole `verify-wallet-switch` flake, not the
  sleeps; assert on a value that identifies the wallet (its balance) instead. Fixed 2026-07-27.
- **…and it now rotates MID-SESSION too**: the money poll re-arms the scan when a payment lands
  at or past `wallet.index`, so a driver that funds the address it is currently showing must
  expect `w-address`/`w-path` to advance to one past the deepest funded index (up to
  `wallet.index + 3` — the scan lands at `frontier + 1`, and the frontier can be `index + 2`,
  the top of the watch window). Fund, then wait on the path you expect — never on the address
  staying put. Pinned by `verify-receive-index` part A.
- Corollary: asserting a PRE-scan state races the scan. `verify-receive-index` part B's
  "a restored wallet starts at index 0" reads `w-path` right after `w-open` appears, while
  `openWallet` has already fired `syncReceiveIndex` — on a loaded machine the scan can win
  (seen once in 3 runs, 2026-07-31). A red there with the following "advances to /7" check
  still green is that race, not a regression.
- Wallet-switcher rows: select by identity (`.wal-row` with/without `.wal-check` = active),
  never `[data-switch]`/`[data-manage]` index — list order is creation order today, but no
  assertion should depend on it.
- Any driver that creates a wallet on a **mainnet or chain-unknown** node must solve the
  backup quiz to escape the ceremony — there is no skip and no Close there (#C3). Proven
  snippet: `verify-wallet-mgmt.mjs` §1; already applied in `verify-beta-posture`,
  `verify-mainnet-bringup`, `verify-mainnet-live`.
