# Testing & drivers

Verified: 2026-07-26 @ `7247899`. Baselines drift — run and compare, don't quote stale counts.
Last known green: all unit suites + 8/8 regtest drivers (98 checks) vs main, 2026-07-26.

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

- Self-contained (mock/stub): `verify-ui` (create/lock/unlock/restore; needs stack),
  `verify-crosswire`, `verify-wallet-mgmt`, `verify-autolock-default`,
  `verify-connect-derive` (sign-to-derive, 6 scenarios, fake EIP-6963 provider),
  `verify-beta-posture`, `verify-honest-quotes` (MOCK_SYSTEM_HEALTH), `verify-oracle-bounds`,
  `verify-oracle-refresh`, `verify-send-amount`, `verify-wallet-switch` (**flaky** — fixed
  sleeps + first-row assumption; fix before CI becomes required), `verify-receive-index`,
  `verify-receive-ui`, `verify-receive-compat` (needs stack), `verify-history`,
  `verify-fiat-sendmax`, `verify-disclaimer`, `verify-mainnet-bringup`.
- Regtest stack: `verify-balance`, `verify-send`, `verify-mint`, `verify-positions`,
  `verify-transfer`, `verify-redeem`, `verify-p2wpkh-change`, `verify-walkthrough`
  (release gate), `verify-fold-shapes` (#118 shapes via testmempoolaccept).

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
- Drivers print "Done." even with red checks — grep `❌`, never trust the tail.
- Never pipe a driver into grep (backgrounded Chrome holds the pipe; shell hangs) —
  redirect to a file, grep the file.
- A driver without explicit `process.exit(process.exitCode || 0)` hangs after "all green".
- Local default Node may be too old for CDP drivers (needs global WebSocket, Node ≥22) —
  use the nvm Node 24 binary.
- Start headless Chrome with `run_in_background` and **poll the CDP endpoint** before
  driving; a fixed 2 s sleep is not enough.
- Assert **intent**, never exact UI copy (see agent-workflow.md).
