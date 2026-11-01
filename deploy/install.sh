#!/bin/sh
# Installs or updates the service on a plain Debian/Ubuntu machine or LXC container.
# Run from the repository root as root: sudo ./deploy/install.sh
set -eu

APP_DIR=/opt/breadboard-simulator-api
ENV_FILE=/etc/breadboard-simulator-api.env
UNIT=/etc/systemd/system/breadboard-simulator-api.service
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo $0)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required. On Debian/Ubuntu:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js $(node -v) is too old; 22.13 or newer is required (it ships the built-in SQLite module)." >&2
  exit 1
fi

if ! id bsimapi >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin bsimapi
fi

mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/src"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  salt=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  sed -e "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$token/" -e "s/^IP_HASH_SALT=.*/IP_HASH_SALT=$salt/" \
    "$SRC_DIR/deploy/breadboard-simulator-api.env.example" > "$ENV_FILE"
  chown root:bsimapi "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "Created $ENV_FILE with a new admin token:"
  echo "  $token"
  echo "Keep it somewhere safe; it is also in that file."
else
  echo "Keeping existing $ENV_FILE"
fi

cp "$SRC_DIR/deploy/breadboard-simulator-api.service" "$UNIT"
ln -sf "$SRC_DIR/deploy/update.sh" /usr/local/bin/bsim-api-update
cp "$SRC_DIR/deploy/breadboard-simulator-api-update.service" "$SRC_DIR/deploy/breadboard-simulator-api-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable breadboard-simulator-api >/dev/null
# Auto-updates from the deploy branch. To turn off for good:
#   touch /etc/breadboard-simulator-api.no-auto-update && systemctl disable --now breadboard-simulator-api-update.timer
if [ ! -f /etc/breadboard-simulator-api.no-auto-update ]; then
  systemctl enable --now breadboard-simulator-api-update.timer >/dev/null
fi
systemctl restart breadboard-simulator-api
systemctl --no-pager --lines=5 status breadboard-simulator-api || true

. "$ENV_FILE"
url="http://${HOST:-127.0.0.1}:${PORT:-8787}/healthz"
for _ in 1 2 3 4 5; do
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "Health check OK: $url"
    exit 0
  fi
  sleep 1
done
echo "Health check did not answer; see: journalctl -u breadboard-simulator-api -e" >&2
exit 1
