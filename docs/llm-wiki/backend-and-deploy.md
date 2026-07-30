# Indexer, faucet, deploy/, scripts/

Verified: 2026-07-26 @ `7247899`. Prod usage of these: ops-and-server.md.

## apps/indexer (`server.js`, ~330 L, port 8789)

Address-level façade over a **stock** ElectrumX (ADR-0003; extend-don't-fork). Per-address
queries only — xpubs never reach it; tx direction deliberately not computed server-side.

- Endpoints: `/api/address/:addr/{utxos,history,positions,dd-utxos}`, `/api/tx/:txid`
  (enriched: confirmations/time/type/feeSats, prevout fan-out capped at 40 → `feeSats:null`),
  `/api/health` (tip height). Upstream failure → 502.
- ElectrumX transport: raw TCP JSON-RPC; `server.version` handshake happens on every
  (re)connect — ElectrumX ≥1.4 kills connections whose first message is anything else.
  16 MiB frame cap; malformed lines skipped.
- Framing is linear (`ElectrumClient#onData`): raw chunks + a resumable 0x0a scan, one
  concat per completed frame — never flatten-and-rescan per chunk (multi-MB verbose-tx
  bodies made that quadratic). Byte-level, so a split multi-byte char can't corrupt a
  frame. The 16 MiB cap counts BYTES; overflow destroys the socket.
- Positions = mint whose collateral vout[0] is unspent and whose OP_RETURN owner key hashes
  to this address's DD-token program. DD amounts pair OP_RETURN cents **positionally** with
  zero-value `5120…` outputs.
- Verbose tx bodies are memoized per server instance and shared by
  positions/dd-utxos/tx (`createTxCache`, max 500, promise-keyed so overlapping callers
  share one upstream call, failures self-evict). TTL `TX_CACHE_TTL_MS` default 5000 —
  keep it under the 15 s block time or pending→mined lags. `listunspent`, `get_history`
  and `headers.subscribe` are never cached.
- Env: `PORT`, `DGB_HRP` (default dgbt), `ELECTRUM_HOST/PORT` (127.0.0.1:50001),
  `TX_CACHE_TTL_MS` (default 5000).

## apps/faucet (`server.js`, ~190 L, port 8788)

Testnet-only hot wallet **on the shared node**. No mock mode by design (down = says so).

- `POST /api/claim {address}` → `{txid, amountSats, amountDgb}`; `GET /api/status`.
- Dispense sizing: collateral for a $50 mint at the 6-month tier × 1.10, rounded up to whole
  DGB — a claim always clears the advertised mint floor. Refuses on missing/stale oracle (503).
- Rate limiting, three layers: persisted per-address AND per-IP 24 h cooldown ledger
  (`FAUCET_DATA_FILE`, survives restarts), lowercase address canonicalization, in-flight
  Set (TOCTOU guard). Exceeded → 429 + `retryAfterMs`.

## deploy/ (tracked files)

| File | Role |
|---|---|
| `docker-compose.yml` | Base stack minus the node: electrumx + indexer + faucet + wallet (only wallet:8791 published). BYO Core v9.26+ with `txindex=1 server=1`. |
| `docker-compose.dual.yml` | Dual-network overlay (**replaces** `.tls.yml`, carries its own Caddy): base = testnet side, adds `electrumx-main`/`indexer-main` (`DGB_HRP: dgb` hardcoded — cannot cross-wire)/`wallet-main` (no faucet, own volume). All mainnet vars `MAINNET_*`, no testnet fallback. |
| `docker-compose.tls.yml` | Legacy single-site TLS overlay (pre-dual). |
| `Caddyfile` / `Caddyfile.dual` | reverse_proxy per domain → wallet / wallet-main. |
| `node.Dockerfile` | One image for wallet/indexer/faucet (`ARG APP`), digest-pinned `node:24-alpine`; keep the Node line in lockstep with `.nvmrc` (#120/#123 lesson). |
| `node-setup.sh` | Installs testnet digibyted as systemd `digibyted`. Trap: `RPC_PORT` defaults to 14022 = **mainnet** port; pass 14026 on a dual host. |
| `mainnet-node-prep.sh` | Idempotent, no-restart prep (#56): fetch 9.26.4, rpcauth users + per-user whitelist (needs `rpcwhitelistdefault=0`), install-not-start `digibyted-mainnet`. Secrets never printed. |
| `mainnet-restart-window.sh` | The owner-run cutover; graceful stop, cmdline-based wait, least-privilege probe. Never force-kills. |

Gitignored/foreign in deploy/: `digidollar-status-service.mjs`, `oracle-price-feeder.mjs`,
`README-digidollar-status.md` (api.digiscope.me status service — different project) and
`.env` (real secrets — never read/echo).

## scripts/

- `check-pins.mjs` — CI supply-chain guard: exact versions in all 5 manifests, digest-pinned
  `FROM` lines, lockfile integrity hashes.
- `regtest-stand.sh` — reproducible regtest node (RPC 18500, dd/ddpass): mines past DD
  activation (650), enables mock oracle, smoke-mints, differential-checks collateral vs
  `requiredCollateralSats`. `--keep` = prerequisite for e2e suites and regtest drivers.
- `run-drivers.sh` — CDP driver runner (see testing-and-drivers.md).
- `electrumx-regtest/` — stock ElectrumX image + DigiByte regtest/testnet coin classes
  (registered via setattr into `electrumx.lib.coins`); `run.sh` runs it in Docker against a
  host node (`DAEMON_URL=http://dd:ddpass@host.docker.internal:18500`). Also the build
  context for the compose electrumx services. Base image `python:3.14-slim` digest-pinned
  (plyvel compiles from sdist — verified fine).
