#!/bin/sh
# Pulls the latest code into this checkout and reinstalls the service.
# install.sh links this script as /usr/local/bin/bsim-api-update, so updating is one command.
set -eu

SCRIPT=$(readlink -f "$0")
REPO_DIR=$(cd "$(dirname "$SCRIPT")/.." && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo $0)" >&2
  exit 1
fi

cd "$REPO_DIR"
before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)
echo "Code: $before -> $after"

# Run the freshly pulled install.sh, not the copy this shell already loaded.
exec "$REPO_DIR/deploy/install.sh"
