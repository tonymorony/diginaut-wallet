#!/usr/bin/env bash
# Build and run ElectrumX against the local regtest stand (scripts/regtest-stand.sh).
#   DAEMON_URL=http://dd:ddpass@host.docker.internal:18500 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

DAEMON_URL="${DAEMON_URL:-http://dd:ddpass@host.docker.internal:18500}"
NAME="${NAME:-electrumx-regtest}"
PORT="${PORT:-50001}"

docker build -q -t dgb-electrumx-regtest .
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e DAEMON_URL="$DAEMON_URL" \
  -p "$PORT":50001 \
  dgb-electrumx-regtest
echo "ElectrumX (regtest) → tcp://127.0.0.1:$PORT  (logs: docker logs -f $NAME)"
