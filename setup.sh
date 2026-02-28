#!/usr/bin/env bash
# setup.sh — One-time setup: creates the prod git worktree, installs dependencies,
#             and installs + enables the systemd user service.
#
# Run this once from the dev repo root (or from anywhere — it uses its own path).
# Safe to re-run: each step checks whether it's already been done.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$SCRIPT_DIR"
PROD_DIR="${HOME}/.local/share/opencode-session-viewer"
PROD_BRANCH="prod"
SERVICE_NAME="opencode-session-viewer"
SERVICE_FILE="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
SERVICE_PORT=18000
# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo "[setup] $*"; }
success() { echo "[setup] ✓ $*"; }
warn()    { echo "[setup] ! $*"; }

# ---------------------------------------------------------------------------
# 1. Ensure we are on main (or at least not on the prod branch)
# ---------------------------------------------------------------------------
info "Checking current branch..."
CURRENT_BRANCH="$(git -C "$DEV_DIR" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "$PROD_BRANCH" ]]; then
    echo "ERROR: You are currently on the '$PROD_BRANCH' branch."
    echo "       Switch to 'main' before running setup."
    exit 1
fi
success "Current branch: $CURRENT_BRANCH"

# ---------------------------------------------------------------------------
# 2. Create (or verify) the prod git worktree
# ---------------------------------------------------------------------------
info "Setting up git worktree at $PROD_DIR..."

if git -C "$DEV_DIR" worktree list --porcelain | grep -q "worktree $PROD_DIR$"; then
    warn "Worktree already exists at $PROD_DIR — skipping creation."
else
    # Create the prod branch if it doesn't exist, then add worktree
    if git -C "$DEV_DIR" show-ref --verify --quiet "refs/heads/$PROD_BRANCH"; then
        git -C "$DEV_DIR" worktree add "$PROD_DIR" "$PROD_BRANCH"
    else
        git -C "$DEV_DIR" worktree add -b "$PROD_BRANCH" "$PROD_DIR" HEAD
    fi
    success "Worktree created at $PROD_DIR on branch '$PROD_BRANCH'."
fi

# ---------------------------------------------------------------------------
# 3. Install Python dependencies in the prod worktree
# ---------------------------------------------------------------------------
info "Running uv sync in prod worktree..."
uv sync --project "$PROD_DIR" --no-dev
success "Dependencies installed in $PROD_DIR/.venv"

# ---------------------------------------------------------------------------
# 4. Install the systemd user service
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
# 5. Enable and start the service
# ---------------------------------------------------------------------------
info "Reloading systemd daemon..."
systemctl --user daemon-reload

info "Enabling service to start on login..."
systemctl --user enable "$SERVICE_NAME"

info "Starting service..."
systemctl --user start "$SERVICE_NAME"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Setup complete."
echo ""
echo "  Service status : systemctl --user status $SERVICE_NAME"
echo "  App URL        : http://127.0.0.1:${SERVICE_PORT}"
echo "  Deploy updates : ./deploy.sh"
echo ""
