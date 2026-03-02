#!/usr/bin/env bash
# restart.sh — Restart the launchd LaunchAgents

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info()    { echo "[launchd/restart] $*"; }
success() { echo "[launchd/restart] ✓ $*"; }

# Use kickstart for a clean restart if available, otherwise stop/start
SERVICE_LABEL="com.opencode.session-viewer.service"
SYNC_LABEL="com.opencode.session-viewer.sync"

info "Restarting service LaunchAgent..."
if launchctl kickstart -k "gui/${UID}/${SERVICE_LABEL}" 2>/dev/null; then
    success "Service restarted via kickstart"
else
    # Fallback to stop/start
    "$SCRIPT_DIR/stop.sh"
    "$SCRIPT_DIR/start.sh"
fi

info "Restarting sync LaunchAgent..."
launchctl kickstart -k "gui/${UID}/${SYNC_LABEL}" 2>/dev/null || true

success "LaunchAgents restarted"
