#!/usr/bin/env bash
# restart.sh — Restart the systemd user service

set -euo pipefail

SERVICE_NAME="opencode-session-viewer"

info()    { echo "[systemd/restart] $*"; }
success() { echo "[systemd/restart] ✓ $*"; }

info "Restarting service..."
systemctl --user restart "$SERVICE_NAME"

success "Service restarted"
