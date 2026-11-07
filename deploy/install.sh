#!/usr/bin/env bash
#
# Bare-metal installer for Debian/Ubuntu. Run as root:
#   sudo bash deploy/install.sh
#
# Installs to /opt/miracle-debrid, data in /var/lib/miracle-debrid,
# runs as an unprivileged "miracle" user under systemd.

set -euo pipefail

APP_DIR=/opt/miracle-debrid
DATA_DIR=/var/lib/miracle-debrid
ENV_FILE=/etc/miracle-debrid.env
SERVICE_USER=miracle
NODE_MAJOR=22

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (sudo bash deploy/install.sh)." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing Node.js ${NODE_MAJOR}.x if needed"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
node -v

echo "==> Creating service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> Copying application to ${APP_DIR}"
mkdir -p "$APP_DIR" "$DATA_DIR/downloads"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude .git --exclude dist \
  "$SRC_DIR"/ "$APP_DIR"/

echo "==> Building"
cd "$APP_DIR"
npm install --no-audit --no-fund
npm run build
npm prune --omit=dev

echo "==> Permissions"
chown -R root:root "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Writing default ${ENV_FILE}"
  TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  HOST_IP="$(hostname -I | awk '{print $1}')"
  cat > "$ENV_FILE" <<EOF
HOST=0.0.0.0
PORT=11470
PUBLIC_URL=http://${HOST_IP}:11470
ACCESS_TOKEN=${TOKEN}
REQUIRE_TOKEN=true
DATA_DIR=${DATA_DIR}
DOWNLOAD_DIR=${DATA_DIR}/downloads
CACHE_MAX_BYTES=100GB
TORRENT_PORT=51413
UPLOAD_LIMIT=131072
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
  echo "    access token: ${TOKEN}"
fi

echo "==> Installing systemd unit"
cp "$APP_DIR/deploy/miracle-debrid.service" /etc/systemd/system/miracle-debrid.service
systemctl daemon-reload
systemctl enable --now miracle-debrid

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Opening firewall ports"
  ufw allow 11470/tcp comment 'miracle-debrid http' || true
  ufw allow 51413/tcp comment 'miracle-debrid peers' || true
  ufw allow 51413/udp comment 'miracle-debrid dht' || true
fi

echo
echo "Done. Status:"
systemctl --no-pager --full status miracle-debrid | head -n 15
echo
echo "Logs:    journalctl -u miracle-debrid -f"
echo "Config:  ${ENV_FILE}"
