#!/usr/bin/env bash
# install.sh — Install launchd LaunchAgents for service and periodic sync
#
# Usage: ./install.sh <PROD_DIR> <SERVICE_PORT>

set -euo pipefail

PROD_DIR="${1:?Usage: $0 <PROD_DIR> <SERVICE_PORT>}"
SERVICE_PORT="${2:?Usage: $0 <PROD_DIR> <SERVICE_PORT>}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.service.plist"
SYNC_PLIST="${LAUNCH_AGENTS_DIR}/com.opencode.session-viewer.sync.plist"
LOG_DIR="${HOME}/Library/Logs"

info()    { echo "[launchd/install] $*"; }
success() { echo "[launchd/install] ✓ $*"; }

# ---------------------------------------------------------------------------
# 1. Create directories
# ---------------------------------------------------------------------------
mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# 2. Install the service LaunchAgent
# ---------------------------------------------------------------------------
info "Installing service LaunchAgent..."

cat > "$SERVICE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.opencode.session-viewer.service</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PROD_DIR}/.venv/bin/uvicorn</string>
        <string>app.main:app</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>${SERVICE_PORT}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROD_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/opencode-session-viewer.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/opencode-session-viewer.error.log</string>
</dict>
</plist>
EOF

success "Service plist written to $SERVICE_PLIST"

# ---------------------------------------------------------------------------
# 3. Install the sync LaunchAgent
# ---------------------------------------------------------------------------
info "Installing sync LaunchAgent..."

cat > "$SYNC_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.opencode.session-viewer.sync</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/curl</string>
        <string>-s</string>
        <string>-X</string>
        <string>POST</string>
        <string>http://127.0.0.1:${SERVICE_PORT}/api/sync</string>
    </array>

    <key>StartInterval</key>
    <integer>60</integer>

    <key>StandardOutPath</key>
    <string>/dev/null</string>

    <key>StandardErrorPath</key>
    <string>/dev/null</string>
</dict>
</plist>
EOF

success "Sync plist written to $SYNC_PLIST"

success "Installation complete"
