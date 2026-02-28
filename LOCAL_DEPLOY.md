# Local Deployment Guide

This documents how to run a stable "prod" instance of the app on localhost alongside active development, accessible at `https://opencode.home`.

## Architecture

- **Dev**: `~/dev/opencode-session-viewer` — normal git workflow on `main`
- **Prod**: `~/.local/share/opencode-session-viewer` — git worktree on `prod` branch
- **Process manager**: systemd user service (starts on login, port 18000)
- **Reverse proxy**: nginx (port 443 → 18000, with TLS)
- **TLS**: `mkcert` local CA trusted by Firefox

---

## One-time Setup

### 1. Install dependencies

```bash
sudo dnf install -y nginx mkcert
```

### 2. Set up the local CA and generate a certificate

```bash
# Install the local CA into system and Firefox trust stores
mkcert -install

# Generate cert for opencode.home (write to /tmp first, then move with sudo)
mkcert -cert-file /tmp/opencode.pem -key-file /tmp/opencode-key.pem opencode.home
sudo mkdir -p /etc/nginx/certs
sudo mv /tmp/opencode.pem /tmp/opencode-key.pem /etc/nginx/certs/

# Fix permissions
sudo chmod 644 /etc/nginx/certs/opencode.pem
sudo chmod 640 /etc/nginx/certs/opencode-key.pem
sudo chown root:nginx /etc/nginx/certs/opencode-key.pem

# Fix SELinux context (files moved from /tmp keep the wrong label)
sudo restorecon -v /etc/nginx/certs/opencode.pem /etc/nginx/certs/opencode-key.pem
```

### 3. Add the hostname to /etc/hosts

```bash
echo '127.0.0.1   opencode.home' | sudo tee -a /etc/hosts
```

### 4. Install the nginx config

```bash
sudo tee /etc/nginx/conf.d/opencode.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name opencode.home;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name opencode.home;

    ssl_certificate     /etc/nginx/certs/opencode.pem;
    ssl_certificate_key /etc/nginx/certs/opencode-key.pem;

    location / {
        proxy_pass http://127.0.0.1:18000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
```

### 5. Allow nginx to proxy to localhost (SELinux)

```bash
sudo setsebool -P httpd_can_network_connect 1
```

### 6. Enable and start nginx

```bash
sudo nginx -t
sudo systemctl enable --now nginx
```

### 7. Set up the prod worktree and systemd service

```bash
./setup.sh
```

This creates the git worktree at `~/.local/share/opencode-session-viewer`, runs `uv sync`, writes the systemd service file, and starts the service.

---

## Deploying Changes

Once setup is complete, the normal deploy workflow is:

```bash
# Commit your changes on main as usual
git add . && git commit -m "your message"

# Push to prod and restart the service
./deploy.sh
```

`deploy.sh` will refuse to run if there are uncommitted changes. Use `--no-restart` to update the code without interrupting the running service.

---

## Useful Commands

| Task                     | Command                                            |
| ------------------------ | -------------------------------------------------- |
| Check service status     | `systemctl --user status opencode-session-viewer`  |
| View service logs        | `journalctl --user -u opencode-session-viewer -f`  |
| Restart service manually | `systemctl --user restart opencode-session-viewer` |
| Check nginx status       | `sudo systemctl status nginx`                      |
| View nginx logs          | `sudo journalctl -u nginx -f`                      |
| Validate nginx config    | `sudo nginx -t`                                    |

---

## Troubleshooting

**502 Bad Gateway**
nginx is running but can't reach the app. Check two things:

1. Is the app running? `systemctl --user is-active opencode-session-viewer`
2. Is the SELinux boolean set? `getsebool httpd_can_network_connect` — if `off`, run `sudo setsebool -P httpd_can_network_connect 1`

**nginx fails to start with Permission denied on cert**
The cert files may have the wrong SELinux label (happens if they were moved from `/tmp`):

```bash
sudo restorecon -v /etc/nginx/certs/opencode.pem /etc/nginx/certs/opencode-key.pem
```

**Firefox shows "Not Secure" despite `mkcert`**
The local CA needs to be installed into Firefox's trust store. Run `mkcert -install` and restart Firefox. Note: `mkcert` must be run as your regular user (not sudo) so it finds Firefox's profile.
