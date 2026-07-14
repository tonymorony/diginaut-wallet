# Mainnet node prep (#56) — upgrade, systemd, least-privilege RPC

Gets the owner's personal mainnet `digibyted` on dgb-server ready to back the
dual-stack wallet (#64). **The restart is owner-run (HITL)** — coordinate the
window; the node is personal infrastructure. Never touch the testnet systemd
unit (`digibyted.service`).

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
   `ExecStart=/root/digibyte-9.26.4/bin/digibyted -datadir=/root/.digibyte`,
   `Restart=on-failure`, `After=network-online.target` — survives reboots.
3. **Two least-privilege RPC users** (generate with Core's
   `share/rpcauth/rpcauth.py`; the passwords land in the server-side
   `deploy/.env` as `MAINNET_RPC_*` / inside `MAINNET_DAEMON_URL` — never in
   the repo):
   - `diginaut` — exactly the wallet proxy's allow-list:
     `rpcwhitelist=diginaut:getblockchaininfo,getdeploymentinfo,getoracleprice,getoracles,getdcamultiplier,getprotectionstatus,sendrawtransaction`
   - `electrumx` — what ElectrumX's daemon interface calls (confirm against
     the pinned ElectrumX before finalizing):
     `rpcwhitelist=electrumx:getblockchaininfo,getblockhash,getblockheader,getblock,getrawtransaction,sendrawtransaction,estimatesmartfee,getnetworkinfo,getmempoolinfo`
   - Do **not** set `rpcwhitelistdefault=1` — the owner's own `rpcuser` keeps
     full access.
4. **Container reachability** — containers cannot reach `127.0.0.1:14022`.
   Mirror the testnet arrangement (`host.docker.internal` via host-gateway):
   add `rpcbind=0.0.0.0` (or 127.0.0.1 + the docker bridge gateway IP) and
   `rpcallowip=172.16.0.0/12` alongside `rpcallowip=127.0.0.1`. The host
   firewall must keep 14022 closed externally (only 22/80/443 open) — verify
   before AND after the restart.

## Restart procedure

```sh
# graceful stop — flushes chainstate; with dbcache=2500 this can take a while.
# NEVER kill -9.
/root/digibyte-9.26.3/bin/digibyte-cli stop
# edit /root/.digibyte/digibyte.conf: rpcauth ×2, rpcwhitelist ×2, rpcbind/rpcallowip
# install the systemd unit, then:
systemctl daemon-reload && systemctl enable --now digibyted-mainnet
```

## Verify

- `digibyte-cli getblockchaininfo` → chain "main", IBD false, height advancing
- `digibyte-cli --version` → 9.26.4
- As `diginaut` via curl: a whitelisted method answers; `getblock` → forbidden
- Testnet untouched: `systemctl status digibyted` still active
- Post-activation (block 23,869,440): `getoracleprice` returns a fresh
  micro-USD price, `is_stale` false — the mainnet wallet's price source
