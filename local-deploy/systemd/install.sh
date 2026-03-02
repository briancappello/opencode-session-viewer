#!/usr/bin/env bash
# install.sh — Install systemd user service and cron job for DB sync
#
# Usage: ./install.sh <PROD_DIR> <SERVICE_PORT>

set -euo pipefail

PROD_DIR="${1:?Usage: $0 <PROD_DIR> <SERVICE_PORT>}"
SERVICE_PORT="${2:?Usage: $0 <PROD_DIR> <SERVICE_PORT>}"
SERVICE_NAME="opencode-session-viewer"
SERVICE_FILE="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"

info()    { echo "[systemd/install] $*"; }
success() { echo "[systemd/install] ✓ $*"; }
warn()    { echo "[systemd/install] ! $*"; }

# ---------------------------------------------------------------------------
# 1. Install the systemd user service
# ---------------------------------------------------------------------------
info "Installing systemd user service..."

mkdir -p "$(dirname "$SERVICE_FILE")"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OpenCode Session Viewer (FastAPI)
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROD_DIR}
ExecStart=${PROD_DIR}/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${SERVICE_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

success "Service file written to $SERVICE_FILE"

# ---------------------------------------------------------------------------
# 2. Install cron job for automatic DB sync
# ---------------------------------------------------------------------------
info "Installing cron job for automatic DB sync..."

CRON_JOB="* * * * * curl -s -X POST http://127.0.0.1:${SERVICE_PORT}/api/sync > /dev/null 2>&1"

if crontab -l 2>/dev/null | grep -qF "/api/sync"; then
    warn "Cron job already exists — skipping."
else
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    success "Cron job installed (runs every minute)"
fi

success "Installation complete"
