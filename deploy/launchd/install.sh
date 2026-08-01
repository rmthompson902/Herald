#!/usr/bin/env bash
# Renders deploy/launchd/*.plist.template for this machine's actual paths and loads them as
# per-user LaunchAgents. Safe to re-run any time (fresh install, after `git pull`, after moving
# the repo) - see docs/07-deployment-operations.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: 'node' not found on PATH. Install it first: brew install node" >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

UVICORN_BIN="$REPO_ROOT/webapp/.venv/bin/uvicorn"
if [[ ! -x "$UVICORN_BIN" ]]; then
  echo "error: $UVICORN_BIN not found." >&2
  echo "Run First-time setup's venv step first (docs/07-deployment-operations.md):" >&2
  echo "  python3 -m venv webapp/.venv && webapp/.venv/bin/pip install -r webapp/requirements-dev.txt" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/logs" "$REPO_ROOT/data" "$LAUNCH_AGENTS_DIR"

render() {
  local template="$1" out="$2"
  sed -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
      -e "s#__NODE_BIN__#$NODE_BIN#g" \
      -e "s#__NODE_BIN_DIR__#$NODE_BIN_DIR#g" \
      "$template" > "$out"
}

render "$SCRIPT_DIR/com.herald.node-red.plist.template" "$LAUNCH_AGENTS_DIR/com.herald.node-red.plist"
render "$SCRIPT_DIR/com.herald.webapp.plist.template" "$LAUNCH_AGENTS_DIR/com.herald.webapp.plist"

for name in com.herald.node-red com.herald.webapp; do
  launchctl unload "$LAUNCH_AGENTS_DIR/$name.plist" 2>/dev/null || true
  launchctl load "$LAUNCH_AGENTS_DIR/$name.plist"
done

echo "Loaded:"
launchctl list | grep herald || echo "(nothing found - something went wrong)"

echo
echo "Verifying (Node-RED can take several seconds to finish loading flows)..."

wait_for() {
  local url="$1" label="$2"
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "warning: $label didn't respond within 20s - check logs/launchd-*-error.log" >&2
  return 1
}

if wait_for "http://127.0.0.1:1880/api/health" "node-red"; then
  curl -s http://127.0.0.1:1880/api/health; echo
fi
if wait_for "http://127.0.0.1:8000/schedules" "webapp"; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/schedules)"
  echo "webapp: $CODE"
fi
