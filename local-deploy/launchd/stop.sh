#!/usr/bin/env bash
# stop.sh — Unload and stop the launchd LaunchAgents

set -euo pipefail

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.service.plist"
SYNC_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.sync.plist"

info()    { echo "[launchd/stop] $*"; }
success() { echo "[launchd/stop] ✓ $*"; }

# ---------------------------------------------------------------------------
# Unload the LaunchAgents
# ---------------------------------------------------------------------------
info "Unloading service LaunchAgent..."
launchctl unload "$SERVICE_PLIST" 2>/dev/null || true

info "Unloading sync LaunchAgent..."
launchctl unload "$SYNC_PLIST" 2>/dev/null || true

success "LaunchAgents stopped"
