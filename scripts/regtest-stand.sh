#!/usr/bin/env bash
# DigiDollar regtest stand — reproducible harness environment (issue #9).
#
# Boots a fresh DigiByte Core regtest node, activates DigiDollar (mine past
# height 650), enables the deterministic mock oracle, smoke-mints $100 of
# DigiDollar, and differentially checks the locked collateral against
# packages/digidollar-js — satoshi-for-satoshi.
#
# Usage:
#   DGB_BIN=/path/to/digibyted ./scripts/regtest-stand.sh [--keep]
#
#   DGB_BIN   digibyted or DigiByte-Qt binary (macOS release ships Qt only —
#             it embeds the full node and accepts the same flags)
#   --keep    leave the node running (default: stop + delete datadir)
#
# Requires: curl, python3, node (>=18), and a DigiByte Core v9.26.4+ binary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DGB_BIN="${DGB_BIN:?set DGB_BIN to a digibyted or DigiByte-Qt binary}"
DATADIR="${DATADIR:-$(mktemp -d /tmp/dgb-regtest-stand.XXXXXX)}"
mkdir -p "$DATADIR"
RPCPORT="${RPCPORT:-18500}"
RPCUSER=dd RPCPASS=ddpass
MOCK_PRICE_MICRO_USD="${MOCK_PRICE_MICRO_USD:-13420}"   # $0.01342/DGB
KEEP=false; [[ "${1:-}" == "--keep" ]] && KEEP=true

rpc() { # rpc <method> <params-json> [wallet]
  local wallet_path=""
  [[ -n "${3:-}" ]] && wallet_path="wallet/$3"
  curl -s --user "$RPCUSER:$RPCPASS" -X POST "http://127.0.0.1:$RPCPORT/$wallet_path" \
    -H 'content-type: text/plain' \
    -d "{\"jsonrpc\":\"1.0\",\"id\":\"stand\",\"method\":\"$1\",\"params\":$2}"
}
result() { python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit("RPC error: %s" % r["error"]) if r["error"] else print(json.dumps(r["result"]))'; }

cleanup() {
  if ! $KEEP; then
    rpc stop '[]' >/dev/null 2>&1 || true
    sleep 2
    rm -rf "$DATADIR"
  else
    echo "node left running: rpc @ 127.0.0.1:$RPCPORT, datadir $DATADIR"
  fi
}
trap cleanup EXIT

echo "→ starting regtest node (datadir: $DATADIR)"
"$DGB_BIN" -regtest -server=1 -datadir="$DATADIR" \
  -rpcuser=$RPCUSER -rpcpassword=$RPCPASS -rpcport="$RPCPORT" \
  -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -listen=0 -fallbackfee=0.001 \
  -min -splash=0 >"$DATADIR/stdout.log" 2>&1 &

for i in $(seq 1 60); do
  rpc getblockchaininfo '[]' 2>/dev/null | grep -q '"chain":"regtest"' && break
  sleep 1
  [[ $i == 60 ]] && { echo "node did not come up"; exit 1; }
done
echo "→ node up"

rpc createwallet '["stand"]' >/dev/null
ADDR=$(rpc getnewaddress '[]' stand | result | tr -d '"')

echo "→ mining 651 blocks to activate DigiDollar (regtest activation height: 650)"
rpc generatetoaddress "[651, \"$ADDR\"]" stand >/dev/null

STATUS=$(rpc getdigidollardeploymentinfo '[]' | result | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
[[ "$STATUS" == "active" ]] || { echo "DigiDollar not active (status: $STATUS)"; exit 1; }
echo "→ DigiDollar ACTIVE"

rpc enablemockoracle '[true]' >/dev/null
rpc setmockoracleprice "[$MOCK_PRICE_MICRO_USD]" >/dev/null
echo "→ mock oracle enabled @ $MOCK_PRICE_MICRO_USD micro-USD"

echo "→ smoke mint: \$100 DigiDollar, tier 3 (180 days / 350%)"
MINT=$(rpc mintdigidollar '[10000, 3]' stand | result)
echo "  $MINT"
CORE_SATS=$(echo "$MINT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(round(float(d["dgb_collateral"]) * 100_000_000))')

echo "→ differential check vs digidollar-js"
node --input-type=module -e "
const { requiredCollateralSats } = await import('$REPO_DIR/packages/digidollar-js/src/index.js');
const ours = requiredCollateralSats({ ddCents: 10_000n, tierId: '6months', oraclePriceMicroUsd: ${MOCK_PRICE_MICRO_USD}n });
const core = ${CORE_SATS}n;
console.log('  digidollar-js:', ours, 'sats');
console.log('  Core mint    :', core, 'sats');
if (ours !== core) { console.error('  ❌ MISMATCH'); process.exit(1); }
console.log('  ✅ EXACT MATCH — satoshi-for-satoshi');
"

echo "→ stand complete"
