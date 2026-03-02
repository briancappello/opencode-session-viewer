#!/usr/bin/env bash
# status.sh — Check the status of the launchd LaunchAgents

set -euo pipefail

SERVICE_LABEL="com.opencode.session-viewer.service"
SYNC_LABEL="com.opencode.session-viewer.sync"
LOG_DIR="${HOME}/Library/Logs"

echo "=== LaunchAgent Status ==="
echo ""
echo "Service agent:"
if launchctl list | grep -q "$SERVICE_LABEL"; then
    launchctl list | grep "$SERVICE_LABEL"
    echo "Status: LOADED"
else
    echo "Status: NOT LOADED"
fi

echo ""
echo "Sync agent:"
if launchctl list | grep -q "$SYNC_LABEL"; then
    launchctl list | grep "$SYNC_LABEL"
    echo "Status: LOADED"
else
    echo "Status: NOT LOADED"
fi

echo ""
echo "=== Recent Logs ==="
if [[ -f "${LOG_DIR}/opencode-session-viewer.log" ]]; then
    echo "--- stdout (last 10 lines) ---"
    tail -n 10 "${LOG_DIR}/opencode-session-viewer.log" 2>/dev/null || echo "(empty)"
else
    echo "No stdout log found"
fi

if [[ -f "${LOG_DIR}/opencode-session-viewer.error.log" ]]; then
    echo ""
    echo "--- stderr (last 10 lines) ---"
    tail -n 10 "${LOG_DIR}/opencode-session-viewer.error.log" 2>/dev/null || echo "(empty)"
else
    echo "No stderr log found"
fi
