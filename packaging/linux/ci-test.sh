#!/usr/bin/env bash
# 在 GitHub Ubuntu 构建机上真实执行 install.sh 并验证：安装 → HTTPS(自签名) + Nginx + SSE → 冒烟 → 重启 →
# 备份 → 恢复 → 升级重装 → 数据保留
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
tar -xzf "$REPO/dist-package/BiddingSystem-linux-x64.tar.gz" -C "$WORK"
PKG="$WORK/BiddingSystem-linux-x64"
export BASE_URL=https://localhost ADMIN_PASSWORD=ci-cloud-password-123 STATE_FILE="$WORK/state.json" NODE_TLS_REJECT_UNAUTHORIZED=0
step() { printf '\n\033[1;36m######## %s\033[0m\n' "$*"; }
smoke() { node "$REPO/tests/package/smoke.mjs" "$1"; }

step '首次安装'
sudo "$PKG/install.sh" --domain localhost --tls self-signed --yes --admin-password "$ADMIN_PASSWORD"
sudo bidding status
curl -sk -o /dev/null -w 'HTTP→HTTPS 跳转：%{http_code} %{redirect_url}\n' http://localhost/admin
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/admin)" = "301" ]
curl -skI https://localhost/admin | grep -i '^strict-transport-security'
# 数据库、程序只监听本机（set -e 下 ! 不会触发失败，因此显式判断）
if ss -ltn | grep -E ':5432\s' | grep -vE '127\.0\.0\.1|\[::1\]'; then echo '数据库对外监听！'; exit 1; fi
if ss -ltn | grep -E ':8080\s' | grep -vE '127\.0\.0\.1'; then echo '程序对外监听！'; exit 1; fi
ss -ltn | grep -E '127\.0\.0\.1:8080'
test -f /etc/cron.d/bidding

step '冒烟测试（经 Nginx + HTTPS）'
smoke setup

step '重启服务后数据保留'
sudo bidding restart
for _ in $(seq 1 30); do curl -fsk https://localhost/healthz >/dev/null 2>&1 && break; sleep 1; done
smoke verify

step '备份与恢复'
sudo bidding backup
FILE="$(sudo bash -c 'ls -1t /var/lib/bidding/backups/manual-*.dump | head -1')"
echo "备份：$FILE"
sudo bidding restore "$FILE" --yes
for _ in $(seq 1 30); do curl -fsk https://localhost/healthz >/dev/null 2>&1 && break; sleep 1; done
smoke verify

step '升级（同一安装包重新运行 install.sh，不带参数）'
sudo "$PKG/install.sh" --yes
smoke verify
[ "$(sudo bash -c 'ls -1d /opt/bidding/releases/* | wc -l')" -ge 2 ]

step '重置管理员密码'
echo -e "ci-new-password-456\nci-new-password-456" | sudo bidding reset-admin
ADMIN_PASSWORD=ci-new-password-456 smoke verify

step '只读维护模式'
sudo bidding readonly on
for _ in $(seq 1 30); do curl -fsk https://localhost/healthz | grep -q '"readOnly":true' && break; sleep 1; done
curl -fsk https://localhost/healthz | grep -q '"readOnly":true'
sudo bidding readonly off

printf '\n\033[1;32m云服务器部署包验证通过\033[0m\n'
