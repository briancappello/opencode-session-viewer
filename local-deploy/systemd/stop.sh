#!/usr/bin/env bash
# stop.sh — Stop and disable the systemd user service

set -euo pipefail

SERVICE_NAME="opencode-session-viewer"

info()    { echo "[systemd/stop] $*"; }
success() { echo "[systemd/stop] ✓ $*"; }

info "Stopping service..."
systemctl --user stop "$SERVICE_NAME" || true

info "Disabling service..."
systemctl --user disable "$SERVICE_NAME" || true

success "Service stopped and disabled"
