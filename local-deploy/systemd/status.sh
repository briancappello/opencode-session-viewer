#!/usr/bin/env bash
# status.sh — Check the status of the systemd user service

set -euo pipefail

SERVICE_NAME="opencode-session-viewer"

echo "=== Service Status ==="
systemctl --user status "$SERVICE_NAME" --no-pager || true

echo ""
echo "=== Cron Job ==="
if crontab -l 2>/dev/null | grep -F "/api/sync"; then
    echo "Cron job is installed"
else
    echo "Cron job is NOT installed"
fi

echo ""
echo "=== Recent Logs ==="
journalctl --user -u "$SERVICE_NAME" -n 10 --no-pager 2>/dev/null || echo "No logs available"
