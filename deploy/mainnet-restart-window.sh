#!/usr/bin/env bash
# Mainnet restart window (#56) — graceful stop of the manually-started 9.26.3,
# then start 9.26.4 under systemd. NEVER kill -9 (dbcache=2500 flush).
set -euo pipefail

echo "== stopping v9.26.3 gracefully =="
# NB: 'pgrep -x digibyted' also matches the TESTNET daemon (same binary name,
# always running) — the loop would never see the mainnet stop. A bare port poll
# on :14022 is ALSO unsafe: deploy/node-setup.sh pins the testnet rpcport to
# 14022 by default (its [test] section, with rpcbind=0.0.0.0), so a testnet
# node rebuilt from that installer would keep :14022 open forever and this loop
# would falsely report "STILL RUNNING" after a clean mainnet stop.
# An RPC probe is no good either: during a graceful stop RPC dies BEFORE the
# dbcache=2500 flush finishes, so it would declare "stopped" while the old
# daemon still holds the datadir lock. Key off the mainnet daemon's unique
# cmdline instead — only the manually-started mainnet 9.26.3 runs from this
# versioned path (testnet runs /usr/local/bin/digibyted).
OLD_BIN=/root/digibyte-9.26.3/bin/digibyted
/root/digibyte-9.26.3/bin/digibyte-cli stop
for i in $(seq 1 120); do
  pgrep -f "$OLD_BIN" >/dev/null || break
  sleep 5
done
if pgrep -f "$OLD_BIN" >/dev/null; then
  echo "STILL RUNNING after 10 min — do NOT force-kill; investigate."; exit 1
fi
echo "stopped cleanly."

echo "== starting v9.26.4 under systemd =="
# The conf has daemon=1; with Type=simple systemd sees the fork parent exit and
# kills the service — the unit MUST carry -daemon=0 (written by mainnet-node-prep.sh).
UNIT=/etc/systemd/system/digibyted-mainnet.service
if ! grep -q -- '-daemon=0' "$UNIT"; then
  echo "unit lacks -daemon=0 — re-run deploy/mainnet-node-prep.sh first."; exit 1
fi
systemctl daemon-reload
systemctl enable --now digibyted-mainnet
sleep 8
systemctl --no-pager --lines=0 status digibyted-mainnet | head -3

echo "== verify (RPC warms up with error -28 'Loading blocks…' — ~10 min at dbcache=2500) =="
CLI=/root/digibyte-9.26.4/bin/digibyte-cli
for i in $(seq 1 150); do
  $CLI getblockchaininfo >/dev/null 2>&1 && break
  sleep 5
done
$CLI getblockchaininfo | python3 -c 'import json,sys; d=json.load(sys.stdin); print("chain:",d["chain"],"height:",d["blocks"],"ibd:",d["initialblockdownload"])'
echo "-- least-privilege probe (reads creds from deploy/.env, prints no secrets) --"
set +x
PASS=$(grep '^MAINNET_RPC_PASS=' /opt/dgb-support/deploy/.env | cut -d= -f2-)
OK=$(curl -s --user "diginaut:${PASS}" -d '{"method":"getblockchaininfo","params":[]}' http://127.0.0.1:14022/ | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["chain"])')
DENIED=$(curl -s --user "diginaut:${PASS}" -d '{"method":"getblock","params":[]}' http://127.0.0.1:14022/ | head -c 80)
echo "whitelisted getblockchaininfo as diginaut → chain: $OK"
echo "non-whitelisted getblock as diginaut → ${DENIED:0:60} (expect forbidden/-32601-ish, NOT a result)"
echo "-- testnet untouched --"
systemctl is-active digibyted && echo "testnet unit: active"
echo "WINDOW DONE."
