# Mainnet node prep (#56) — upgrade, systemd, least-privilege RPC

Gets the owner's personal mainnet `digibyted` on dgb-server ready to back the
dual-stack wallet (#64). **The restart is owner-run (HITL)** — coordinate the
window; the node is personal infrastructure. Never touch the testnet systemd
unit (`digibyted.service`).

Executable form: `deploy/mainnet-node-prep.sh` (safe anytime, no restart) and
`deploy/mainnet-restart-window.sh` (the restart window itself). This doc is the
why; the scripts are the how.

## State as inspected 2026-07-14 (read-only)

| Fact | Value |
|---|---|
| Binary / version | `/root/digibyte-9.26.3/bin/digibyted` — **v9.26.3**, needs 9.26.4 |
| Started | manually (`daemon=1`, cwd `/root/digibyte-9.26.3/bin`) — **not systemd; a reboot kills it** |
| Datadir | `/root/.digibyte` (default) |
| Chain | main, synced (23,852,264 = headers, IBD false, not pruned) |
| Wallet-relevant conf | `txindex=1`, `digidollar=1`, `dbcache=2500` — already correct |
| RPC | `rpcbind=127.0.0.1`, `rpcallowip=127.0.0.1`, port 14022, single `rpcuser` (owner's) |
| DD activation | block 23,869,440 ≈ 2026-07-17 |

Per the #52 findings (`docs/discovery/mainnet-oracle-findings.md`): **no oracle
config is needed** — `digidollar=1` + sync is all; never point
`oracle-price-feeder.mjs` at this node (its RPCs are regtest-only).

## Changes to make (in one restart window)

1. **Upgrade to v9.26.4** — same release recipe as `deploy/node-setup.sh`
   (`digibyte-9.26.4-x86_64-linux-gnu.tar.gz` from the GitHub release), unpack
   to `/root/digibyte-9.26.4`. Do not reuse the testnet binary path
   (`/usr/local/bin/digibyted` belongs to the testnet unit).
2. **systemd unit `digibyted-mainnet.service`** (distinct name!):
   `ExecStart=/root/digibyte-9.26.4/bin/digibyted -datadir=/root/.digibyte -daemon=0`,
   `Restart=on-failure`, `After=network-online.target` — survives reboots.
   `-daemon=0` is **REQUIRED**: the conf has `daemon=1`, and with `Type=simple`
   systemd sees the fork parent exit and kills the freshly started service.
3. **Two least-privilege RPC users** (generate with Core's
   `share/rpcauth/rpcauth.py`; the passwords land in the server-side
   `deploy/.env` as `MAINNET_RPC_*` / inside `MAINNET_DAEMON_URL` — never in
   the repo):
   - `diginaut` — exactly the wallet proxy's allow-list:
     `rpcwhitelist=diginaut:getblockchaininfo,getdeploymentinfo,getoracleprice,getoracles,getdcamultiplier,getprotectionstatus,sendrawtransaction`
   - `electrumx` — what ElectrumX's daemon interface actually calls (CONFIRMED
     the hard way 2026-07-17: the original guess omitted `getblockcount` — the
     height poll — and `getrawmempool`, so ElectrumX looped on 403 "daemon
     service refused: Forbidden" and never began its genesis sync; watch for
     that exact log line after any whitelist change):
     `rpcwhitelist=electrumx:getblockchaininfo,getblockcount,getrawmempool,getblockhash,getblockheader,getblock,getrawtransaction,sendrawtransaction,estimatesmartfee,getnetworkinfo,getmempoolinfo`
   - `rpcwhitelistdefault=0` is **REQUIRED**: in Core, setting ANY
     `rpcwhitelist=` flips every non-whitelisted user (the owner's `rpcuser`!)
     to an EMPTY default whitelist — without it the owner is locked out of his
     own node (every `digibyte-cli` call 403s). Hit in production 2026-07-17.
4. **Container reachability** — containers cannot reach `127.0.0.1:14022`.
   Mirror the testnet arrangement (`host.docker.internal` via host-gateway):
   set `rpcbind=0.0.0.0` and `rpcallowip=172.16.0.0/12` alongside
   `rpcallowip=127.0.0.1`. **REPLACE** (comment out) the existing
   `rpcbind=127.0.0.1` line — first `rpcbind` wins in Core, so adding
   `0.0.0.0` alongside it leaves the node localhost-only (hit in production).
   The host must keep 14022 closed externally (only 22/80/443 open) — verify
   before AND after the restart.

## Restart procedure

Run `deploy/mainnet-restart-window.sh`. What it does, and why:

```sh
# graceful stop — flushes chainstate; with dbcache=2500 this can take a while.
# NEVER kill -9.
/root/digibyte-9.26.3/bin/digibyte-cli stop
# wait for the MAINNET daemon specifically: poll ss -tln for :14022 to vanish.
# 'pgrep -x digibyted' also matches the always-running TESTNET daemon (same
# binary name) — a pgrep loop never sees the mainnet stop (hit in production).
# conf edits and unit install are done beforehand by mainnet-node-prep.sh, then:
systemctl daemon-reload && systemctl enable --now digibyted-mainnet
```

Long ssh sessions to dgb-server get reset — run long server operations
detached (`nohup … >log 2>&1 &`) and poll the log with short sessions instead
of sitting in one.

## Verify

- RPC warms up first: `getblockchaininfo` returns error -28 "Loading blocks…"
  for ~10 min after start (dbcache=2500 reload) — wait, don't restart.
- **Post-DD-activation boots take 40–60+ min MORE**: after "Starting network
  threads…" the v9.26.4 init runs `OracleBundleManager::LoadPricesFromChain`,
  scanning the last **172,800 blocks** for oracle prices (one log line:
  "Oracle: Scanning last 172800 blocks…", then SILENCE until "Done loading").
  During the scan RPC stays -28 and NO peers connect — the node looks wedged
  but is not. **NEVER restart during this phase — a restart resets the scan
  to zero** (hit twice in production on activation day 2026-07-17; the
  "wedge" was this scan both times).
- Invalid third-party blocks are fine: activation day saw a rogue miner
  broadcast DD blocks without MuSig2 oracle bundles; `bad-oracle-missing`
  ConnectBlock errors in the log mean the node REJECTED them, as did the
  whole network (explorer height keeps advancing without those hashes).
  Rejection errors + advancing network ≠ our node forked.
- `digibyte-cli getblockchaininfo` → chain "main", IBD false, height advancing
- `digibyte-cli --version` → 9.26.4
- As `diginaut` via curl: a whitelisted method answers; `getblock` → forbidden
- If `digibyte-cli` (owner's `rpcuser`) 403s on everything → the
  whitelist-default trap: `rpcwhitelistdefault=0` is missing (see step 3).
- Testnet untouched: `systemctl status digibyted` still active
- Post-activation (block 23,869,440): `getoracleprice` returns a fresh
  micro-USD price, `is_stale` false — the mainnet wallet's price source

## As executed 2026-07-17

| Fact | Value |
|---|---|
| Version / unit | **v9.26.4** running under `digibyted-mainnet.service` (`-daemon=0`) |
| Conf | rpcauth ×2 + whitelists, `rpcwhitelistdefault=0`, `rpcbind=0.0.0.0` (old `127.0.0.1` line commented out), `rpcallowip=172.16.0.0/12` |
| Firewall | `ufw` **inactive** — owner accepted rpcallowip-only guarding of 14022, matching the testnet node |
| Dual stack | up (`deploy/docker-compose.dual.yml`) |
| Bugs hit & fixed | pgrep matched testnet daemon; unit lacked `-daemon=0`; whitelist-default lockout; first-rpcbind-wins — all folded into the two `deploy/` scripts |
