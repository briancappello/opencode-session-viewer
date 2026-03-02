#!/usr/bin/env bash
# uninstall.sh — Remove launchd LaunchAgents

set -euo pipefail

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.service.plist"
SYNC_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.sync.plist"

info()    { echo "[launchd/uninstall] $*"; }
success() { echo "[launchd/uninstall] ✓ $*"; }
warn()    { echo "[launchd/uninstall] ! $*"; }

# ---------------------------------------------------------------------------
# 1. Unload the LaunchAgents
# ---------------------------------------------------------------------------
info "Unloading LaunchAgents..."
launchctl unload "$SERVICE_PLIST" 2>/dev/null || true
launchctl unload "$SYNC_PLIST" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Remove plist files
# ---------------------------------------------------------------------------
if [[ -f "$SERVICE_PLIST" ]]; then
    rm -f "$SERVICE_PLIST"
    success "Removed $SERVICE_PLIST"
else
    warn "Service plist not found"
fi

if [[ -f "$SYNC_PLIST" ]]; then
    rm -f "$SYNC_PLIST"
    success "Removed $SYNC_PLIST"
else
    warn "Sync plist not found"
fi

success "Uninstall complete"

echo ""
echo "Note: Log files were not removed. To delete them:"
echo "  rm -f ~/Library/Logs/opencode-session-viewer.log"
echo "  rm -f ~/Library/Logs/opencode-session-viewer.error.log"
