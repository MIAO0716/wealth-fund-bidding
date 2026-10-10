#!/usr/bin/env bash
# 理财、基金现场竞标系统 · 云服务器一键安装 / 升级（Ubuntu 22.04/24.04、Debian 12，x86_64）
#
#   首次安装：sudo ./install.sh --domain bid.example.com --email you@example.com
#   升级    ：解压新版本后在新目录里再次运行 sudo ./install.sh（沿用原有配置与数据）
#
# 选项：
#   --domain 域名          对外访问的域名（必填；--tls none 时也可填服务器公网 IP）
#   --email 邮箱           申请 HTTPS 证书用（Let's Encrypt 到期提醒）
#   --tls 方式             letsencrypt（默认，自动申请免费证书）| self-signed（自签名，仅测试）| none（仅 HTTP，不推荐）
#   --port 端口            程序内部端口，默认 8080（只监听本机，由 Nginx 对外）
#   --admin-password 密码  首次安装时的管理员密码；不填则交互输入（也可用环境变量 BIDDING_ADMIN_PASSWORD）
#   --yes                  非交互模式（缺少必要参数时直接报错）
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT=/opt/bidding
CONF_DIR=/etc/bidding
ENV_FILE=$CONF_DIR/bidding.env
DATA_DIR=/var/lib/bidding
BACKUP_DIR=$DATA_DIR/backups
SERVICE=bidding

DOMAIN="" EMAIL="" TLS="letsencrypt" PORT="" YES=0
ADMIN_PASSWORD="${BIDDING_ADMIN_PASSWORD:-}"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m[完成]\033[0m %s\n' "$*"; }
warn() { printf '    \033[35m[注意]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[出错] %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --tls) TLS="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo ./install.sh --domain 你的域名 --email 你的邮箱（或先 su - 切换到 root）"
[ -f "$PKG_DIR/VERSION" ] && [ -x "$PKG_DIR/node/bin/node" ] || die "安装包不完整，请重新下载并解压后在解压目录中运行"
[ "$(uname -m)" = "x86_64" ] || die "仅支持 x86_64 服务器"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "仅支持 Ubuntu 22.04/24.04 或 Debian 12（当前：${PRETTY_NAME:-未知}）" ;; esac
case "$TLS" in letsencrypt|self-signed|none) ;; *) die "--tls 只能是 letsencrypt、self-signed 或 none" ;; esac

# 升级时沿用原有配置
envval() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
UPGRADE=0
if [ -f "$ENV_FILE" ]; then
  UPGRADE=1
  OLD_URL="$(envval PUBLIC_BASE_URL)"
  [ -n "$DOMAIN" ] || DOMAIN="$(printf '%s' "$OLD_URL" | sed -E 's#^https?://##; s#[:/].*$##')"
  [ -n "$PORT" ] || PORT="$(envval PORT)"
  if [ "$TLS" = "letsencrypt" ] && [ -f "$CONF_DIR/tls-mode" ]; then TLS="$(cat "$CONF_DIR/tls-mode")"; fi
fi
PORT="${PORT:-8080}"

if [ -z "$DOMAIN" ]; then
  [ "$YES" -eq 0 ] || die "缺少 --domain"
  read -r -p "请输入对外访问的域名（例如 bid.example.com）：" DOMAIN
fi
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || die "域名格式不正确：$DOMAIN"
if [ "$TLS" = "letsencrypt" ] && [ -z "$EMAIL" ] && [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  [ "$YES" -eq 0 ] || die "申请 HTTPS 证书需要 --email"
  read -r -p "请输入邮箱（证书到期提醒用）：" EMAIL
fi

VERSION="$(cat "$PKG_DIR/VERSION")"
say "理财、基金现场竞标系统 · $( [ $UPGRADE -eq 1 ] && echo 升级 || echo 安装 )"
echo "    版本：$VERSION"
echo "    域名：$DOMAIN（证书：$TLS）"

# ---------------------------------------------------------------- 系统依赖
say "安装系统依赖（PostgreSQL、Nginx$( [ "$TLS" = letsencrypt ] && echo '、Certbot' )）"
export DEBIAN_FRONTEND=noninteractive
PKGS="postgresql postgresql-client nginx openssl ca-certificates curl cron"
[ "$TLS" = "letsencrypt" ] && PKGS="$PKGS certbot python3-certbot-nginx"
apt-get update -qq >/dev/null
# shellcheck disable=SC2086
apt-get install -y -qq $PKGS >/dev/null
systemctl enable --now postgresql >/dev/null 2>&1 || true
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl enable --now cron >/dev/null 2>&1 || true
ok "依赖已就绪"

# ---------------------------------------------------------------- 用户与目录
id "$SERVICE" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE"
install -d -o "$SERVICE" -g "$SERVICE" -m 750 "$DATA_DIR" "$BACKUP_DIR"
install -d -m 750 -g "$SERVICE" "$CONF_DIR"

# ---------------------------------------------------------------- 程序文件（多版本并存，current 指向当前版本）
say "部署程序文件"
REL="$APP_ROOT/releases/$(date +%Y%m%d-%H%M%S)"
install -d "$REL"
cp -a "$PKG_DIR/node" "$PKG_DIR/app" "$PKG_DIR/scripts" "$PKG_DIR/VERSION" "$REL/"
chown -R root:root "$REL"
chmod -R a+rX "$REL"
ln -sfn "$REL" "$APP_ROOT/current"
ln -sfn "$APP_ROOT/current/scripts/bidding" /usr/local/bin/bidding
# 只保留最近 3 个版本
ls -1dt "$APP_ROOT"/releases/* 2>/dev/null | tail -n +4 | xargs -r rm -rf
ok "已部署到 $REL"

# ---------------------------------------------------------------- 数据库（只监听本机）
say "配置数据库"
DATABASE_URL="$(envval DATABASE_URL)"
if [ -z "$DATABASE_URL" ]; then
  DB_PASS="$(openssl rand -hex 24)"
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$SERVICE'" | grep -q 1; then
    runuser -u postgres -- psql -q -c "ALTER ROLE $SERVICE WITH LOGIN PASSWORD '$DB_PASS'"
  else
    runuser -u postgres -- psql -q -c "CREATE ROLE $SERVICE WITH LOGIN PASSWORD '$DB_PASS'"
  fi
  DATABASE_URL="postgres://$SERVICE:$DB_PASS@127.0.0.1:5432/$SERVICE"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='$SERVICE'" | grep -q 1; then
  runuser -u postgres -- createdb -O "$SERVICE" "$SERVICE"
fi
ok "数据库就绪（仅本机可访问）"

# ---------------------------------------------------------------- 配置文件
SCHEME=https
[ "$TLS" = "none" ] && SCHEME=http
COOKIE_SECURE=true
[ "$TLS" = "none" ] && COOKIE_SECURE=false
READ_ONLY="$(envval READ_ONLY)"
umask 027
cat > "$ENV_FILE" <<EOF
# 由 install.sh 生成；修改后执行 sudo bidding restart 生效
DATABASE_URL=$DATABASE_URL
HOST=127.0.0.1
PORT=$PORT
PUBLIC_BASE_URL=$SCHEME://$DOMAIN
TRUST_PROXY=true
COOKIE_SECURE=$COOKIE_SECURE
WEB_DIST=$APP_ROOT/current/app/apps/web/dist
MIGRATIONS_DIR=$APP_ROOT/current/app/apps/server/migrations
BACKUP_DIR=$BACKUP_DIR
PG_DUMP_PATH=/usr/bin/pg_dump
READ_ONLY=${READ_ONLY:-false}
LOG_LEVEL=info
NODE_ENV=production
EOF
chown root:"$SERVICE" "$ENV_FILE"
chmod 640 "$ENV_FILE"
echo "$TLS" > "$CONF_DIR/tls-mode"
umask 022

# ---------------------------------------------------------------- 系统服务
say "配置系统服务（开机自启、异常自动重启）"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=理财、基金现场竞标系统
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$SERVICE
Group=$SERVICE
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_ROOT/current
ExecStart=$APP_ROOT/current/node/bin/node $APP_ROOT/current/app/apps/server/dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
for i in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  [ "$i" -eq 60 ] && { journalctl -u "$SERVICE" -n 50 --no-pager; die "程序启动失败，日志见上方（也可执行 sudo bidding logs）"; }
  sleep 1
done
ok "程序已启动"

# ---------------------------------------------------------------- 管理员（仅首次）
ADMINS="$(runuser -u postgres -- psql -d "$SERVICE" -tAc 'SELECT count(*) FROM admins' 2>/dev/null || echo 0)"
if [ "${ADMINS// /}" = "0" ]; then
  say "设置管理员密码（账号 admin）"
  if [ -z "$ADMIN_PASSWORD" ]; then
    [ "$YES" -eq 0 ] || die "首次安装需要 --admin-password（或环境变量 BIDDING_ADMIN_PASSWORD）"
    while true; do
      read -r -s -p "请输入管理员密码（至少 10 位）：" P1; echo
      read -r -s -p "请再输入一次：" P2; echo
      [ "$P1" = "$P2" ] || { warn "两次输入不一致"; continue; }
      [ "${#P1}" -ge 10 ] || { warn "至少 10 位"; continue; }
      ADMIN_PASSWORD="$P1"; break
    done
  fi
  BIDDING_NEW_PASSWORD="$ADMIN_PASSWORD" "$APP_ROOT/current/scripts/bidding" set-admin-password >/dev/null
  ok "管理员 admin 已创建"
fi

# ---------------------------------------------------------------- Nginx 与 HTTPS
say "配置 Nginx$( [ "$TLS" != none ] && echo ' 与 HTTPS' )"
SITE=/etc/nginx/sites-available/$SERVICE.conf
PROXY_COMMON="proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;"
LOCATIONS="client_max_body_size 4m;

    # 实时推送（SSE）：关闭缓冲、放宽超时
    location ~ ^/api/v1/.*/stream\$ {
        proxy_pass http://127.0.0.1:$PORT;
        $PROXY_COMMON
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        $PROXY_COMMON
    }"

if [ "$TLS" = "self-signed" ]; then
  if [ ! -f "$CONF_DIR/tls/cert.pem" ]; then
    install -d -m 700 "$CONF_DIR/tls"
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN" -keyout "$CONF_DIR/tls/key.pem" -out "$CONF_DIR/tls/cert.pem" >/dev/null 2>&1
  fi
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate $CONF_DIR/tls/cert.pem;
    ssl_certificate_key $CONF_DIR/tls/key.pem;
    $LOCATIONS
}
EOF
elif [ "$TLS" = "letsencrypt" ] && [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  # 证书已存在（升级）：直接写入 HTTPS 配置
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    $LOCATIONS
}
EOF
else
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    $LOCATIONS
}
EOF
fi
ln -sfn "$SITE" /etc/nginx/sites-enabled/$SERVICE.conf
# 系统自带的默认站点会抢占 80 端口的默认响应，移除其启用链接（原文件保留）
[ -L /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx 配置检查失败"; }
systemctl reload nginx

if [ "$TLS" = "letsencrypt" ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  say "申请免费 HTTPS 证书（Let's Encrypt）"
  if ! certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect -n >/tmp/bidding-certbot.log 2>&1; then
    tail -n 20 /tmp/bidding-certbot.log
    die "证书申请失败。请检查：① 域名已解析到本服务器公网 IP；② 云服务器安全组已放行 80 和 443 端口；③ 中国大陆服务器的域名已完成 ICP 备案。处理后重新运行本脚本即可。"
  fi
  ok "HTTPS 证书已申请（到期前自动续期）"
fi

# ---------------------------------------------------------------- 防火墙与定时备份
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null
  ok "防火墙已放行 22、80、443"
fi
cat > /etc/cron.d/$SERVICE <<EOF
# 每天 03:30 自动备份，保留最近 30 份
30 3 * * * root /usr/local/bin/bidding backup --label daily --keep 30 --quiet
EOF
chmod 644 /etc/cron.d/$SERVICE
ok "已设置每天自动备份（$BACKUP_DIR）"

# ---------------------------------------------------------------- 完成
URL="$SCHEME://$DOMAIN"
printf '\n\033[1;32m=================================================\033[0m\n'
printf '\033[1;32m  %s完成\033[0m\n' "$( [ $UPGRADE -eq 1 ] && echo 升级 || echo 安装 )"
printf '  管理端：%s/admin   （账号 admin）\n' "$URL"
printf '  领导扫码、大屏链接均使用：%s\n' "$URL"
printf '  常用命令：sudo bidding status | logs | backup | restore 文件 | reset-admin\n'
printf '\033[1;32m=================================================\033[0m\n'
[ "$TLS" = "self-signed" ] && warn "当前为自签名证书，手机会提示「不安全」，仅用于测试；正式使用请改为 --tls letsencrypt"
[ "$TLS" = "none" ] && warn "当前未启用 HTTPS，数据明文传输，不建议正式使用"
exit 0
