#!/usr/bin/env bash
# uninstall.sh — Remove systemd service and cron job

set -euo pipefail

SERVICE_NAME="opencode-session-viewer"
SERVICE_FILE="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"

info()    { echo "[systemd/uninstall] $*"; }
success() { echo "[systemd/uninstall] ✓ $*"; }
warn()    { echo "[systemd/uninstall] ! $*"; }

# ---------------------------------------------------------------------------
# 1. Stop and disable the service
# ---------------------------------------------------------------------------
info "Stopping service..."
systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Remove service file
# ---------------------------------------------------------------------------
if [[ -f "$SERVICE_FILE" ]]; then
    rm -f "$SERVICE_FILE"
    success "Removed $SERVICE_FILE"
else
    warn "Service file not found at $SERVICE_FILE"
fi

# ---------------------------------------------------------------------------
# 3. Remove cron job
# ---------------------------------------------------------------------------
info "Removing cron job..."
if crontab -l 2>/dev/null | grep -qF "/api/sync"; then
    crontab -l 2>/dev/null | grep -vF "/api/sync" | crontab -
    success "Cron job removed"
else
    warn "Cron job not found"
fi

# ---------------------------------------------------------------------------
# 4. Reload daemon
# ---------------------------------------------------------------------------
systemctl --user daemon-reload

success "Uninstall complete"
