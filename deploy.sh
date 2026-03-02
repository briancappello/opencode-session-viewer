#!/usr/bin/env bash
# deploy.sh — Deploy the current state of main to the prod worktree and restart
#             the service (systemd on Linux, launchd on macOS).
#
# Usage: ./deploy.sh [--no-restart]
#   --no-restart   Update the prod worktree but skip the service restart.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$SCRIPT_DIR"
PROD_DIR="${HOME}/.local/share/opencode-session-viewer"
PROD_BRANCH="prod"
SERVICE_NAME="opencode-session-viewer"
SERVICE_PORT=18000
NO_RESTART=false

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
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
    case $arg in
        --no-restart) NO_RESTART=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo "[deploy] $*"; }
success() { echo "[deploy] ✓ $*"; }

# ---------------------------------------------------------------------------
# 1. Sanity checks
# ---------------------------------------------------------------------------
info "Checking prerequisites..."

# Ensure the prod worktree exists
if [[ ! -e "$PROD_DIR/.git" ]]; then
    echo "ERROR: Prod worktree not found at $PROD_DIR"
    echo "       Run ./setup.sh first."
    exit 1
fi

# Ensure we're on main (deploying from an unintended branch is usually a mistake)
CURRENT_BRANCH="$(git -C "$DEV_DIR" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "WARNING: You are on branch '$CURRENT_BRANCH', not 'main'."
    read -r -p "         Deploy '$CURRENT_BRANCH' to prod anyway? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# Ensure app code is clean (avoid deploying uncommitted changes to app/)
if ! git -C "$DEV_DIR" diff --quiet -- app/ || ! git -C "$DEV_DIR" diff --cached --quiet -- app/; then
    echo "ERROR: You have uncommitted changes in app/."
    echo "       Commit or stash them before deploying."
    exit 1
fi

success "Checks passed (branch: $CURRENT_BRANCH)"

# ---------------------------------------------------------------------------
# 2. Merge current branch into prod
# ---------------------------------------------------------------------------
info "Merging '$CURRENT_BRANCH' into '$PROD_BRANCH'..."
DEPLOY_SHA="$(git -C "$DEV_DIR" rev-parse HEAD)"
git -C "$PROD_DIR" fetch "$DEV_DIR" "$CURRENT_BRANCH"
git -C "$PROD_DIR" merge --ff-only "$DEPLOY_SHA"

DEPLOYED_SHA="$(git -C "$PROD_DIR" rev-parse --short "$DEPLOY_SHA")"
success "Prod is now at $DEPLOYED_SHA"

# ---------------------------------------------------------------------------
# 3. Sync dependencies (in case pyproject.toml / uv.lock changed)
# ---------------------------------------------------------------------------
info "Syncing dependencies..."
uv sync --project "$PROD_DIR" --no-dev
success "Dependencies up to date"

# ---------------------------------------------------------------------------
# 4. Restart the service
# ---------------------------------------------------------------------------
if [[ "$NO_RESTART" == true ]]; then
    echo ""
    echo "Skipped service restart (--no-restart)."
    echo "To restart manually: ./local-deploy/${INIT_SYSTEM}/restart.sh"
else
    info "Restarting service..."
    "${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/restart.sh"
    success "Service restarted"

    # Brief pause then check it actually came up
    sleep 2
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SERVICE_PORT}/api/sync" | grep -q "200"; then
        success "Service is running"
    else
        echo "ERROR: Service failed to start after restart."
        echo "       Check status with: ./local-deploy/${INIT_SYSTEM}/status.sh"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Deployed $DEPLOYED_SHA → http://127.0.0.1:18000"
echo ""
