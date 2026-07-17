#!/usr/bin/env bash
# Mainnet restart window (#56) — graceful stop of the manually-started 9.26.3,
# then start 9.26.4 under systemd. NEVER kill -9 (dbcache=2500 flush).
set -euo pipefail

echo "== stopping v9.26.3 gracefully =="
/root/digibyte-9.26.3/bin/digibyte-cli stop
for i in $(seq 1 120); do
  pgrep -x digibyted >/dev/null || break
  sleep 5
done
if pgrep -x digibyted >/dev/null; then
  echo "STILL RUNNING after 10 min — do NOT force-kill; investigate."; exit 1
fi
echo "stopped cleanly."

echo "== starting v9.26.4 under systemd =="
systemctl enable --now digibyted-mainnet
sleep 8
systemctl --no-pager --lines=0 status digibyted-mainnet | head -3

echo "== verify =="
CLI=/root/digibyte-9.26.4/bin/digibyte-cli
for i in $(seq 1 24); do
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
