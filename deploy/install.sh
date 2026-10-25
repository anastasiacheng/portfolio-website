#!/usr/bin/env bash
# Installs or updates the site and the admin backend from this repo.
# Usage: sudo deploy/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/portfolio
SITE=/var/www/mywebsite
PASSWORD_FILE=/etc/.mywebsite_password
OWNER="${SUDO_USER:?run with sudo from your own account}"

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
cd "$REPO"

if [[ -e "$SITE/.git" ]]; then
    echo "$SITE/.git exists. The public folder must not contain the repo; move it out first." >&2
    exit 1
fi

echo "== Tests"
sudo -u "$OWNER" npm test --silent

echo "== Service user"
id portfolio &>/dev/null || useradd --system --home-dir /var/lib/portfolio --shell /usr/sbin/nologin portfolio

echo "== App code -> $APP (root-owned, read-only to the service)"
install -d -m 755 "$APP"
rsync -a --delete --exclude __pycache__ --chown=root:root --chmod=D755,F644 \
    server admin js index.html style.css "$APP/"

echo "== Public folder: $OWNER owns it, the service may publish into it"
install -m 644 style.css "$SITE/style.css"
chown -R "$OWNER:portfolio" "$SITE"
find "$SITE" -type d -exec chmod 2775 {} +
find "$SITE" -type f -exec chmod 664 {} +

echo "== Password file"
if [[ ! -s "$PASSWORD_FILE" ]]; then
    (umask 077; python3 -c "import secrets; print(secrets.token_urlsafe(18))" > "$PASSWORD_FILE")
    echo "Created $PASSWORD_FILE with a new random password."
fi
chown root:portfolio "$PASSWORD_FILE"
chmod 640 "$PASSWORD_FILE"

echo "== Service"
install -m 644 deploy/portfolio-admin.env /etc/portfolio-admin.env
install -m 644 deploy/portfolio-admin.service /etc/systemd/system/portfolio-admin.service
systemctl daemon-reload
systemctl enable --quiet portfolio-admin
systemctl restart portfolio-admin

echo "== Rebuild index.html from the new template"
runuser -u portfolio -- bash -c 'set -a; . /etc/portfolio-admin.env; cd /opt/portfolio && python3 -m server.rebuild'

echo "== Caddy"
grep -q "^import /etc/caddy/portfolio.caddy" /etc/caddy/Caddyfile || {
    echo "Add 'import /etc/caddy/portfolio.caddy' to /etc/caddy/Caddyfile (in place of the site block)." >&2
    exit 1
}
if ! cmp -s deploy/portfolio.caddy /etc/caddy/portfolio.caddy; then
    [[ -f /etc/caddy/portfolio.caddy ]] && cp /etc/caddy/portfolio.caddy /etc/caddy/portfolio.caddy.bak
    install -m 644 deploy/portfolio.caddy /etc/caddy/portfolio.caddy
    if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile &>/dev/null; then
        echo "Caddy rejected the new config; putting the old one back." >&2
        [[ -f /etc/caddy/portfolio.caddy.bak ]] && mv /etc/caddy/portfolio.caddy.bak /etc/caddy/portfolio.caddy
        exit 1
    fi
    systemctl reload caddy
fi

echo "== Smoke check"
# Retries because the service may still be starting after the restart above.
curl -fsS -o /dev/null --retry 10 --retry-connrefused http://127.0.0.1:8091/admin/login && echo "Admin backend is up."
