#!/usr/bin/env bash
# uninstall.sh — Remove nginx reverse proxy configuration for opencode-session-viewer
#
# Usage: ./uninstall.sh <HOSTNAME>

set -euo pipefail

HOSTNAME="${1:?Usage: $0 <HOSTNAME>}"

info()    { echo "[nginx/uninstall] $*"; }
success() { echo "[nginx/uninstall] ✓ $*"; }
warn()    { echo "[nginx/uninstall] ! $*"; }

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
PLATFORM="$(uname -s)"
case "$PLATFORM" in
    Linux*)
        NGINX_CONF_DIR="/etc/nginx"
        NGINX_SITES_DIR="/etc/nginx/sites-enabled"
        SSL_DIR="/etc/nginx/ssl"
        ;;
    Darwin*)
        NGINX_CONF_DIR="/usr/local/etc/nginx"
        if [[ -d "/opt/homebrew/etc/nginx" ]]; then
            NGINX_CONF_DIR="/opt/homebrew/etc/nginx"
        fi
        NGINX_SITES_DIR="${NGINX_CONF_DIR}/servers"
        SSL_DIR="${NGINX_CONF_DIR}/ssl"
        ;;
    *)
        echo "ERROR: Unsupported platform: $PLATFORM"
        exit 1
        ;;
esac

NGINX_CONF_FILE="${NGINX_SITES_DIR}/${HOSTNAME}.conf"
SSL_CERT="${SSL_DIR}/${HOSTNAME}.pem"
SSL_KEY="${SSL_DIR}/${HOSTNAME}-key.pem"

# ---------------------------------------------------------------------------
# 1. Remove nginx configuration
# ---------------------------------------------------------------------------
info "Removing nginx configuration..."

if [[ -f "$NGINX_CONF_FILE" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        rm -f "$NGINX_CONF_FILE"
    else
        sudo rm -f "$NGINX_CONF_FILE"
    fi
    success "Removed $NGINX_CONF_FILE"
else
    warn "nginx config not found at $NGINX_CONF_FILE"
fi

# ---------------------------------------------------------------------------
# 2. Remove SSL certificates
# ---------------------------------------------------------------------------
info "Removing SSL certificates..."

if [[ -f "$SSL_CERT" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        rm -f "$SSL_CERT"
    else
        sudo rm -f "$SSL_CERT"
    fi
    success "Removed $SSL_CERT"
else
    warn "SSL cert not found"
fi

if [[ -f "$SSL_KEY" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        rm -f "$SSL_KEY"
    else
        sudo rm -f "$SSL_KEY"
    fi
    success "Removed $SSL_KEY"
else
    warn "SSL key not found"
fi

# ---------------------------------------------------------------------------
# 3. Remove from /etc/hosts
# ---------------------------------------------------------------------------
info "Removing ${HOSTNAME} from /etc/hosts..."

if grep -qE "^127\.0\.0\.1[[:space:]]+.*\b${HOSTNAME}\b" /etc/hosts; then
    # Create a backup and remove the line
    sudo cp /etc/hosts /etc/hosts.bak
    grep -vE "^127\.0\.0\.1[[:space:]]+${HOSTNAME}$" /etc/hosts | sudo tee /etc/hosts.tmp > /dev/null
    sudo mv /etc/hosts.tmp /etc/hosts
    success "Removed ${HOSTNAME} from /etc/hosts"
else
    warn "${HOSTNAME} not found in /etc/hosts"
fi

# ---------------------------------------------------------------------------
# 4. Reload nginx
# ---------------------------------------------------------------------------
info "Reloading nginx..."

if command -v nginx &>/dev/null; then
    if sudo nginx -t 2>&1; then
        if [[ "$PLATFORM" == "Darwin" ]]; then
            if brew services list 2>/dev/null | grep -q "nginx.*started"; then
                brew services restart nginx
            elif pgrep -x nginx > /dev/null; then
                sudo nginx -s reload
            fi
        else
            sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload 2>/dev/null || true
        fi
        success "nginx reloaded"
    fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
success "nginx configuration removed for ${HOSTNAME}"
echo ""
