#!/usr/bin/env bash
# install.sh — Install nginx reverse proxy configuration for opencode-session-viewer
#
# Usage: ./install.sh <SERVICE_PORT> <HOSTNAME>
#
# Requires: nginx, mkcert (will prompt to install if missing)

set -euo pipefail

SERVICE_PORT="${1:?Usage: $0 <SERVICE_PORT> <HOSTNAME>}"
HOSTNAME="${2:?Usage: $0 <SERVICE_PORT> <HOSTNAME>}"

info()    { echo "[nginx/install] $*"; }
success() { echo "[nginx/install] ✓ $*"; }
warn()    { echo "[nginx/install] ! $*"; }
error()   { echo "[nginx/install] ERROR: $*"; exit 1; }

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
        # Homebrew nginx paths
        NGINX_CONF_DIR="/usr/local/etc/nginx"
        if [[ -d "/opt/homebrew/etc/nginx" ]]; then
            NGINX_CONF_DIR="/opt/homebrew/etc/nginx"
        fi
        NGINX_SITES_DIR="${NGINX_CONF_DIR}/servers"
        SSL_DIR="${NGINX_CONF_DIR}/ssl"
        ;;
    *)
        error "Unsupported platform: $PLATFORM"
        ;;
esac

NGINX_CONF_FILE="${NGINX_SITES_DIR}/${HOSTNAME}.conf"
SSL_CERT="${SSL_DIR}/${HOSTNAME}.pem"
SSL_KEY="${SSL_DIR}/${HOSTNAME}-key.pem"

# ---------------------------------------------------------------------------
# 1. Check for nginx
# ---------------------------------------------------------------------------
info "Checking for nginx..."
if ! command -v nginx &>/dev/null; then
    error "nginx is not installed. Please install it first:
       macOS:  brew install nginx
       Ubuntu: sudo apt install nginx"
fi
success "nginx found"

# ---------------------------------------------------------------------------
# 2. Check for mkcert
# ---------------------------------------------------------------------------
info "Checking for mkcert..."
if ! command -v mkcert &>/dev/null; then
    error "mkcert is not installed. Please install it first:
       macOS:  brew install mkcert && mkcert -install
       Ubuntu: sudo apt install mkcert && mkcert -install
       
       See: https://github.com/FiloSottile/mkcert"
fi
success "mkcert found"

# ---------------------------------------------------------------------------
# 3. Create SSL directory and certificates
# ---------------------------------------------------------------------------
info "Creating SSL certificates with mkcert..."

if [[ ! -d "$SSL_DIR" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        mkdir -p "$SSL_DIR"
    else
        sudo mkdir -p "$SSL_DIR"
    fi
fi

if [[ -f "$SSL_CERT" && -f "$SSL_KEY" ]]; then
    warn "SSL certificates already exist — skipping generation"
else
    # mkcert outputs to current directory, so we specify full paths
    if [[ "$PLATFORM" == "Darwin" ]]; then
        mkcert -cert-file "$SSL_CERT" -key-file "$SSL_KEY" "$HOSTNAME"
    else
        # On Linux, SSL dir is typically owned by root
        mkcert -cert-file "/tmp/${HOSTNAME}.pem" -key-file "/tmp/${HOSTNAME}-key.pem" "$HOSTNAME"
        sudo mv "/tmp/${HOSTNAME}.pem" "$SSL_CERT"
        sudo mv "/tmp/${HOSTNAME}-key.pem" "$SSL_KEY"
    fi
    success "SSL certificates created"
fi

# ---------------------------------------------------------------------------
# 4. Create nginx configuration
# ---------------------------------------------------------------------------
info "Creating nginx configuration..."

if [[ ! -d "$NGINX_SITES_DIR" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        mkdir -p "$NGINX_SITES_DIR"
    else
        sudo mkdir -p "$NGINX_SITES_DIR"
    fi
fi

NGINX_CONF_CONTENT="server {
    listen 443 ssl;
    server_name ${HOSTNAME};

    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:${SERVICE_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket support (if needed)
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name ${HOSTNAME};
    return 301 https://\$server_name\$request_uri;
}
"

if [[ "$PLATFORM" == "Darwin" ]]; then
    echo "$NGINX_CONF_CONTENT" > "$NGINX_CONF_FILE"
else
    echo "$NGINX_CONF_CONTENT" | sudo tee "$NGINX_CONF_FILE" > /dev/null
fi

success "nginx config written to $NGINX_CONF_FILE"

# ---------------------------------------------------------------------------
# 5. Update /etc/hosts
# ---------------------------------------------------------------------------
info "Checking /etc/hosts for ${HOSTNAME}..."

if grep -qE "^127\.0\.0\.1[[:space:]]+.*\b${HOSTNAME}\b" /etc/hosts; then
    warn "${HOSTNAME} already in /etc/hosts — skipping"
else
    info "Adding ${HOSTNAME} to /etc/hosts (requires sudo)..."
    echo "127.0.0.1    ${HOSTNAME}" | sudo tee -a /etc/hosts > /dev/null
    success "Added ${HOSTNAME} to /etc/hosts"
fi

# ---------------------------------------------------------------------------
# 6. Test and reload nginx
# ---------------------------------------------------------------------------
info "Testing nginx configuration..."
if sudo nginx -t 2>&1; then
    success "nginx configuration is valid"
else
    error "nginx configuration test failed"
fi

info "Reloading nginx..."
if [[ "$PLATFORM" == "Darwin" ]]; then
    # macOS: nginx might be managed by brew services or running standalone
    if brew services list 2>/dev/null | grep -q "nginx.*started"; then
        brew services restart nginx
    elif pgrep -x nginx > /dev/null; then
        sudo nginx -s reload
    else
        # Start nginx if not running
        sudo nginx
    fi
else
    sudo systemctl reload nginx || sudo nginx -s reload
fi

success "nginx reloaded"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
success "nginx reverse proxy configured"
echo "  URL: https://${HOSTNAME}"
echo ""
