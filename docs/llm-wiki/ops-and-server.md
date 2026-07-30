# Ops & server

Verified: 2026-07-31. Server specifics (IPs, key paths, creds) live in agent memory and
server-side files — **never** in this repo. Runbooks: `docs/runbooks/`.

## Live deployments (dual stack, one server, 8 containers)

- **Four hostnames, two containers.** Canonical since 2026-07-31:
  <https://diginaut.space> (mainnet → `wallet-main`), <https://testnet.diginaut.space>
  (testnet → `wallet`). Legacy, still served, **never redirected**:
  <https://diginaut.ludere.space> (mainnet), <https://dgb.ludere.space> (testnet).
- The no-redirect rule is load-bearing, not politeness: the vault is IndexedDB, which is
  origin-scoped, so a redirect drops a funded user onto an empty wallet. The hostname also
  selects the frozen sign-to-derive bytes — legacy → v1/v2, everything else → v3/v4
  (**ADR-0006**), so the legacy hosts must keep answering under their own names forever.
- Caddy takes a comma-separated address list per site; both eras live in one `.env`
  (`/opt/dgb-support/deploy/.env`, untracked, 0600):
  `TESTNET_DOMAINS=dgb.ludere.space, testnet.diginaut.space` /
  `MAINNET_DOMAINS=diginaut.ludere.space, diginaut.space`. Dropping a host takes that site
  down; `deploy/Caddyfile.dual` + `docker-compose.dual.yml` are domain-agnostic and need no
  edit to add one. Cutover procedure: `docs/runbooks/domain-cutover-2026-07.md`.
- Compose = **THREE** -f files: `docker-compose.yml` + `docker-compose.dual.yml` +
  server-local `docker-compose.cache.yml` (ElectrumX CACHE_MB overlay; not in repo).
  The `.tls` overlay is **no longer used** (pre-dual-stack).
- Build identity: `curl -s <domain>/api/config` → `version` field (`v<semver>+<sha>`).
  There is no `/api/version`. Prod is deployed from `git archive` (tar to `/opt/dgb-support`,
  a plain copy, no .git) so the export-subst stamp resolves; `.env` survives (untracked).

## Deploy recipes (verified)

- Frontend-only (normal case):
  `docker compose -f docker-compose.yml -f docker-compose.dual.yml -f docker-compose.cache.yml up --build -d --no-deps wallet wallet-main`
  — `--no-deps` is **LOAD-BEARING**: without it compose rebuilds non-reproducible
  indexer/faucet images and recreates the whole closure **including electrumx-main**, whose
  restart closes port 50001 for ~10 min (mainnet balances down).
- Full-stack `up --build -d` only for compose/infra changes, expecting that window.
- Adding/removing a hostname = edit `.env`, then `… up -d caddy` (recreates one container to
  pick up the env and issue certs; brief TLS blip on the existing domains, wallets untouched).
  DNS must already resolve or ACME fails.
- After deploy: verify served `app.js` sha256 vs repo + run `verify-dual-public.mjs` **twice**,
  once per pair (canonical, then legacy — separate Caddy sites, separate certs, so a break on
  one is invisible from the other).

## Server facts & gotchas

- Migrated 2026-07-22 (47 GB RAM / 400 GB SSD; old 11 GB box OOM-killed electrumx-main
  forever). electrumx-main steady state ≈ 15–17 GB RSS. Full resync reference: node IBD ~31 h,
  ElectrumX genesis ~39 h (tx-bound, 54 M txs).
- ufw must allow **172.16.0.0/12 → RPC ports** (docker→host; symptom: ElectrumX "timeout
  error. Retrying occasionally" forever) + p2p ports open.
- Two nodes on the box: testnet `digibyted` + user's personal mainnet `digibyted-mainnet`
  (systemd, `-daemon=0` required). `rpcwhitelistdefault=0` is REQUIRED with rpcauth users;
  first `rpcbind` line wins. **Restarts of the mainnet node are owner-run (HITL).**
- ssh: long sessions get RESET (~2 min) — run long ops detached (nohup+log fails the
  classifier; plain foreground `docker compose up --build -d` over ssh works), poll with
  short sessions, use ServerAliveInterval=5. Intermittent resets are a path issue from the
  user's machine — don't blame the server.
- Classifier constraints (auto mode): reading prod configs/creds is blocked; **read-only
  `digibyte-cli` calls over ssh are fine**; `pkill` over ssh: always `-x`, never `-f`.
- Faucet test-reset: `docker exec deploy-faucet-1 rm /data/faucet-claims.json` + compose
  restart faucet (claims are one-per-IP-per-24h). Top-up: server-side mine script.
- Triage the indexer with `/api/tx/<unknown txid>` and read the body's **`cause`** (never the
  copy — upstream text is no longer relayed at all): **404 `not found`** = trio healthy (the
  probe reached ElectrumX and came back); 502 `upstream-error` = backend up but answering
  errors (still syncing, node warming); 502 `upstream-unreachable` = the link is actually
  down; the wallet proxy's own `indexer-unreachable`/`faucet-unreachable` = that hop failed.
  Real errors: `docker logs deploy-indexer-1` / `deploy-wallet-1` (`indexer: …` / `wallet: …`).
  Before this pass the probe answered 502 with a raw `daemon-error`/`ECONNREFUSED` repr and no
  `cause` — a not-yet-redeployed container still does.
- Config backups live server-side/user-side (0700) — never commit.
