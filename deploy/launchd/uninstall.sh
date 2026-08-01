#!/usr/bin/env bash
# Unloads and removes the LaunchAgents installed by install.sh. Stays installed until this runs -
# see docs/07-deployment-operations.md.
#
# By default, the database (schedules/VOG messages/cue cache) is left in place - uninstalling the
# launchd registration is not the same as wiping application data. Pass --purge-data to also remove
# it (moved to a timestamped backup alongside it, not deleted outright, so a purge is still
# recoverable if it was a mistake).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

PURGE_DATA=false
for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=true ;;
  esac
done

for name in com.herald.node-red com.herald.webapp; do
  launchctl unload "$LAUNCH_AGENTS_DIR/$name.plist" 2>/dev/null || true
  rm -f "$LAUNCH_AGENTS_DIR/$name.plist"
done

echo "Verifying nothing's left:"
launchctl list | grep herald && echo "warning: still present" >&2 || echo "(none)"

if [[ "$PURGE_DATA" == true ]]; then
  if [[ -d "$REPO_ROOT/data" ]]; then
    BACKUP="$REPO_ROOT/data.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$REPO_ROOT/data" "$BACKUP"
    echo "Purged: $REPO_ROOT/data moved to $BACKUP (delete it yourself once you're sure you don't need it)."
    echo "Next install.sh + Node-RED start will create a fresh, empty database."
  else
    echo "No data/ directory to purge."
  fi
fi
