#!/usr/bin/env bash
# start.sh — Load and start the launchd LaunchAgents

set -euo pipefail

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.service.plist"
SYNC_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.sync.plist"

info()    { echo "[launchd/start] $*"; }
success() { echo "[launchd/start] ✓ $*"; }
warn()    { echo "[launchd/start] ! $*"; }

# ---------------------------------------------------------------------------
# Load the LaunchAgents
# ---------------------------------------------------------------------------
info "Loading service LaunchAgent..."
if launchctl load "$SERVICE_PLIST" 2>/dev/null; then
    success "Service LaunchAgent loaded"
else
    warn "Service LaunchAgent may already be loaded"
fi

info "Loading sync LaunchAgent..."
if launchctl load "$SYNC_PLIST" 2>/dev/null; then
    success "Sync LaunchAgent loaded"
else
    warn "Sync LaunchAgent may already be loaded"
fi

success "LaunchAgents started"
