#!/usr/bin/env bash
# Install the DigiByte v9.26.4 (DigiDollar preview) node as a systemd service
# on a Linux server, configured for TESTNET with everything the wallet stack
# needs (server=1, txindex=1). Idempotent-ish; run as root.
#   RPC_USER=dd RPC_PASS=$(openssl rand -hex 16) ./node-setup.sh
set -euo pipefail

VERSION="${VERSION:-9.26.4}"
RPC_USER="${RPC_USER:?set RPC_USER}"
RPC_PASS="${RPC_PASS:?set RPC_PASS}"
# WARNING (#56): 14022 is the MAINNET rpcport. On a host co-located with the
# mainnet daemon (the dual stack), this default COLLIDES with it — pass an
# explicit RPC_PORT (e.g. 14026, the v9.26.4 testnet default). The live dual
# host's testnet daemon does NOT run on 14022; this default predates the dual
# stack and does not reflect that deployment.
RPC_PORT="${RPC_PORT:-14022}" # pinned explicitly below (v9.26.4 testnet default is 14026; 14022 is mainnet's)
DATADIR="${DATADIR:-/var/lib/digibyte}"

case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64) ARCH=aarch64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v digibyted >/dev/null; then
  TARBALL="digibyte-${VERSION}-${ARCH}-linux-gnu.tar.gz"
  echo "Downloading ${TARBALL}…"
  curl -fL -o "/tmp/${TARBALL}" \
    "https://github.com/DigiByte-Core/digibyte/releases/download/v${VERSION}/${TARBALL}"
  tar -xzf "/tmp/${TARBALL}" -C /tmp
  install -m 0755 /tmp/digibyte-*/bin/digibyted /tmp/digibyte-*/bin/digibyte-cli /usr/local/bin/
  rm -rf /tmp/digibyte-* "/tmp/${TARBALL}"
fi

id -u digibyte >/dev/null 2>&1 || useradd -r -m -d "$DATADIR" -s /usr/sbin/nologin digibyte
mkdir -p "$DATADIR"

if [ ! -f "$DATADIR/digibyte.conf" ]; then
  cat > "$DATADIR/digibyte.conf" <<EOF
testnet=1
server=1
txindex=1

[test]
rpcuser=${RPC_USER}
rpcpassword=${RPC_PASS}
rpcport=${RPC_PORT}
# bind wide but allow only localhost + docker networks (compose reaches the
# node via host-gateway); keep ${RPC_PORT} CLOSED in the host firewall.
rpcbind=0.0.0.0
rpcallowip=127.0.0.1
rpcallowip=172.16.0.0/12
EOF
  chmod 600 "$DATADIR/digibyte.conf"
fi
chown -R digibyte:digibyte "$DATADIR"

cat > /etc/systemd/system/digibyted.service <<EOF
[Unit]
Description=DigiByte testnet daemon (DigiDollar preview)
After=network-online.target
Wants=network-online.target

[Service]
User=digibyte
ExecStart=/usr/local/bin/digibyted -datadir=${DATADIR}
Restart=on-failure
RestartSec=15
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now digibyted
echo "digibyted (testnet) running. Follow sync:"
echo "  sudo -u digibyte digibyte-cli -datadir=${DATADIR} -testnet getblockchaininfo"
