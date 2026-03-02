#!/usr/bin/env bash
# setup.sh — One-time setup: creates the prod git worktree, installs dependencies,
#             installs + enables the service (systemd on Linux, launchd on macOS),
#             and configures nginx reverse proxy with HTTPS.
#
# Run this once from the dev repo root (or from anywhere — it uses its own path).
# Safe to re-run: each step checks whether it's already been done.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths & Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$SCRIPT_DIR"
PROD_DIR="${HOME}/.local/share/opencode-session-viewer"
PROD_BRANCH="prod"
SERVICE_NAME="opencode-session-viewer"
SERVICE_PORT=18000
SERVICE_HOSTNAME="opencode.home"

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
PLATFORM="$(uname -s)"
case "$PLATFORM" in
    Linux*)   INIT_SYSTEM="systemd" ;;
    Darwin*)  INIT_SYSTEM="launchd" ;;
    *)
        echo "ERROR: Unsupported platform: $PLATFORM"
        echo "       Supported platforms: Linux (systemd), macOS (launchd)"
        exit 1
        ;;
esac
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
# 4. Install the service (platform-specific)
# ---------------------------------------------------------------------------
info "Installing ${INIT_SYSTEM} service..."
"${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/install.sh" "$PROD_DIR" "$SERVICE_PORT"

# ---------------------------------------------------------------------------
# 5. Enable and start the service
# ---------------------------------------------------------------------------
info "Starting service..."
"${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/start.sh"

# ---------------------------------------------------------------------------
# 6. Configure nginx reverse proxy with HTTPS
# ---------------------------------------------------------------------------
info "Setting up nginx reverse proxy..."
"${SCRIPT_DIR}/local-deploy/nginx/install.sh" "$SERVICE_PORT" "$SERVICE_HOSTNAME"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Setup complete. (platform: ${PLATFORM}, init: ${INIT_SYSTEM})"
echo ""
echo "  Service status : ./service.sh status"
echo "  App URL        : https://${SERVICE_HOSTNAME}"
echo "  Deploy updates : ./deploy.sh"
echo ""
