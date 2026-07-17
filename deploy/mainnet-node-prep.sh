#!/usr/bin/env bash
# Mainnet node prep (#56) — SAFE TO RUN ANYTIME (no restart, testnet untouched).
# Idempotent. Secrets are generated server-side and written only to
# /root/.digibyte/digibyte.conf and /opt/dgb-support/deploy/.env — never printed.
set -euo pipefail

VERSION=9.26.4
CONF=/root/.digibyte/digibyte.conf
ENVF=/opt/dgb-support/deploy/.env
UNIT=/etc/systemd/system/digibyted-mainnet.service

echo "== 1/4 binary =="
if [ ! -x /root/digibyte-${VERSION}/bin/digibyted ]; then
  curl -fsSL -o /tmp/dgb.tgz \
    "https://github.com/DigiByte-Core/digibyte/releases/download/v${VERSION}/digibyte-${VERSION}-x86_64-linux-gnu.tar.gz"
  tar -xzf /tmp/dgb.tgz -C /root && rm /tmp/dgb.tgz
fi
/root/digibyte-${VERSION}/bin/digibyted --version | head -1

echo "== 2/4 rpcauth + whitelist + bind (digibyte.conf) =="
cp -n "$CONF" "${CONF}.bak-pre-mainnet-prep" || true
python3 - "$CONF" "$ENVF" <<'PY'
import sys, hmac, hashlib, secrets, urllib.parse, os
conf, envf = sys.argv[1], sys.argv[2]
ctext = open(conf).read()
etext = open(envf).read()
cadd, eadd = [], []

def rpcauth(user):
    pw = secrets.token_urlsafe(32)
    salt = secrets.token_hex(16)
    h = hmac.new(salt.encode(), pw.encode(), hashlib.sha256).hexdigest()
    return pw, f"rpcauth={user}:{salt}${h}"

if "rpcauth=diginaut:" not in ctext:
    pw, line = rpcauth("diginaut")
    cadd += [line,
      "rpcwhitelist=diginaut:getblockchaininfo,getdeploymentinfo,getoracleprice,getoracles,getdcamultiplier,getprotectionstatus,sendrawtransaction"]
    eadd += ["MAINNET_RPC_URL=http://host.docker.internal:14022",
             "MAINNET_RPC_USER=diginaut",
             f"MAINNET_RPC_PASS={pw}"]

if "rpcauth=electrumx:" not in ctext:
    pw, line = rpcauth("electrumx")
    cadd += [line,
      "rpcwhitelist=electrumx:getblockchaininfo,getblockhash,getblockheader,getblock,getrawtransaction,sendrawtransaction,estimatesmartfee,getnetworkinfo,getmempoolinfo"]
    eadd += [f"MAINNET_DAEMON_URL=http://electrumx:{urllib.parse.quote(pw, safe='')}@host.docker.internal:14022"]

for line in ("rpcbind=0.0.0.0", "rpcallowip=172.16.0.0/12"):
    if line not in ctext:
        cadd.append(line)

for line in ("TESTNET_DOMAINS=dgb.ludere.space", "MAINNET_DOMAINS=diginaut.ludere.space"):
    key = line.split("=")[0]
    if key + "=" not in etext:
        eadd.append(line)

if cadd:
    with open(conf, "a") as f:
        f.write("\n# --- mainnet-prep (#56): least-privilege RPC for the Diginaut stack ---\n")
        f.write("\n".join(cadd) + "\n")
if eadd:
    with open(envf, "a") as f:
        f.write("\n# --- mainnet dual-stack (#64) ---\n")
        f.write("\n".join(eadd) + "\n")
os.chmod(envf, 0o600)
print(f"conf lines added: {len(cadd)}; env keys added: {len([e for e in eadd])}")
PY

echo "== 3/4 systemd unit (installed, NOT started) =="
if [ ! -f "$UNIT" ]; then
cat > "$UNIT" <<EOF
[Unit]
Description=DigiByte mainnet daemon (Diginaut backing node, #56)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/root/digibyte-${VERSION}/bin/digibyted -datadir=/root/.digibyte
Restart=on-failure
RestartSec=15
User=root

[Install]
WantedBy=multi-user.target
EOF
fi
systemctl daemon-reload
echo "unit present: $UNIT (start happens in the restart window)"

echo "== 4/4 firewall check (must stay: only 22/80/443 external) =="
(ufw status 2>/dev/null || iptables -L INPUT -n | head -12) | sed -n '1,12p'
ss -tlnp | grep 14022 || true
echo "PREP DONE — no restart performed; testnet unit untouched."
