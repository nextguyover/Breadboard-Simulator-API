#!/bin/sh
# Brings this checkout up to date with the deploy branch and reinstalls the service.
# install.sh links this script as /usr/local/bin/bsim-api-update.
#
#   bsim-api-update          update now (prints what it does)
#   bsim-api-update --auto   used by the timer: silent unless there is something new
#
# The branch comes from DEPLOY_BRANCH in /etc/breadboard-simulator-api.env (default: prod).
# A new version is only installed if its tests pass, and it is rolled back if the
# service doesn't come up healthy.
set -eu

SCRIPT=$(readlink -f "$0")
REPO_DIR=$(cd "$(dirname "$SCRIPT")/.." && pwd)
ENV_FILE=/etc/breadboard-simulator-api.env
AUTO=0
[ "${1:-}" = "--auto" ] && AUTO=1

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo $0)" >&2
  exit 1
fi

# One update at a time (the timer and a manual run could overlap).
exec 9>/run/bsim-api-update.lock
if ! flock -n 9; then
  [ "$AUTO" = 1 ] || echo "Another update is running" >&2
  exit 0
fi

BRANCH=prod
if [ -f "$ENV_FILE" ]; then
  b=$(sed -n 's/^DEPLOY_BRANCH=//p' "$ENV_FILE" | tail -n 1)
  [ -n "$b" ] && BRANCH=$b
fi

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
before=$(git rev-parse HEAD)
target=$(git rev-parse "origin/$BRANCH")

FAILED=/run/bsim-api-update.failed
if [ "$AUTO" = 1 ]; then
  # Nothing new, or a version that already failed: don't retry it every minute.
  [ "$before" = "$target" ] && exit 0
  [ "$(cat "$FAILED" 2>/dev/null)" = "$target" ] && exit 0
fi
echo "Updating $(git rev-parse --short "$before") -> $(git rev-parse --short "$target") from $BRANCH"

# This checkout is only used for deploying, so it simply follows the branch.
git checkout --quiet -B "$BRANCH" "$target"

if ! node --disable-warning=ExperimentalWarning --test test/*.test.js >/tmp/bsim-api-tests.log 2>&1; then
  echo "Tests failed on $(git rev-parse --short "$target"); keeping the running version. Log: /tmp/bsim-api-tests.log" >&2
  git checkout --quiet -B "$BRANCH" "$before"
  echo "$target" >"$FAILED"
  exit 1
fi

# Run the freshly checked-out install.sh, not the copy this shell already loaded.
if ! "$REPO_DIR/deploy/install.sh"; then
  echo "New version is not healthy; rolling back to $(git rev-parse --short "$before")" >&2
  git checkout --quiet -B "$BRANCH" "$before"
  "$REPO_DIR/deploy/install.sh" || true
  echo "$target" >"$FAILED"
  exit 1
fi
rm -f "$FAILED"
echo "Now running $(git rev-parse --short HEAD)"
