#!/usr/bin/env bash
# start.sh — Enable and start the systemd user service

set -euo pipefail

SERVICE_NAME="opencode-session-viewer"

info()    { echo "[systemd/start] $*"; }
success() { echo "[systemd/start] ✓ $*"; }

info "Reloading systemd daemon..."
systemctl --user daemon-reload

info "Enabling service to start on login..."
systemctl --user enable "$SERVICE_NAME"

info "Starting service..."
systemctl --user start "$SERVICE_NAME"

success "Service started"
