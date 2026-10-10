#!/usr/bin/env bash
# 组装云服务器部署包（在 Linux x86_64 构建机上运行，需先执行 npm ci 与 npm run build）
# 产物：dist-package/BiddingSystem-linux-x64.tar.gz
#   BiddingSystem-linux-x64/
#     install.sh             一键安装/升级
#     部署说明.txt
#     node/bin/node          便携 Node.js
#     app/                   构建好的前后端与生产依赖
#     scripts/bidding        管理命令
#     VERSION
set -euo pipefail
NODE_VERSION="${NODE_VERSION:-22.23.3}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO/dist-package"
NAME=BiddingSystem-linux-x64
STAGE="$OUT/$NAME"
cd "$REPO"

for p in apps/server/dist apps/web/dist; do [ -d "$p" ] || { echo "缺少 $p，请先执行 npm run build"; exit 1; }; done
rm -rf "$STAGE" && mkdir -p "$STAGE/app/apps/server" "$STAGE/app/apps/web" "$OUT/cache"

echo "==> 应用程序"
cp -r apps/server/dist "$STAGE/app/apps/server/dist"
rm -f "$STAGE"/app/apps/server/dist/*.map
cp -r apps/server/migrations "$STAGE/app/apps/server/migrations"
cp apps/server/package.json "$STAGE/app/apps/server/package.json"
cp -r apps/web/dist "$STAGE/app/apps/web/dist"
cp package.json "$STAGE/app/package.json"

echo "==> 生产依赖（按 package-lock.json 锁定版本）"
DEPS="$OUT/deps-linux"
rm -rf "$DEPS" && mkdir -p "$DEPS/packages/shared" "$DEPS/apps/server" "$DEPS/apps/web"
cp package.json package-lock.json .npmrc "$DEPS/"
cp packages/shared/package.json "$DEPS/packages/shared/"
cp apps/server/package.json "$DEPS/apps/server/"
cp apps/web/package.json "$DEPS/apps/web/"
(cd "$DEPS" && npm ci --omit=dev --workspace @bidding/server --ignore-scripts --no-audit --no-fund >/dev/null)
rm -rf "$DEPS/node_modules/@bidding" "$DEPS/node_modules/.bin"
mv "$DEPS/node_modules" "$STAGE/app/node_modules"

echo "==> Node.js $NODE_VERSION"
TARBALL="node-v$NODE_VERSION-linux-x64.tar.xz"
[ -f "$OUT/cache/$TARBALL" ] || curl -fsSL -o "$OUT/cache/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" > "$OUT/cache/sum.txt"
(cd "$OUT/cache" && sha256sum -c sum.txt)
mkdir -p "$STAGE/node/bin"
tar -xJf "$OUT/cache/$TARBALL" -C "$OUT/cache"
cp "$OUT/cache/node-v$NODE_VERSION-linux-x64/bin/node" "$STAGE/node/bin/node"
cp "$OUT/cache/node-v$NODE_VERSION-linux-x64/LICENSE" "$STAGE/node/LICENSE"

echo "==> 脚本与说明"
cp packaging/linux/install.sh "$STAGE/install.sh"
mkdir -p "$STAGE/scripts"
cp packaging/linux/scripts/bidding "$STAGE/scripts/bidding"
cp packaging/linux/部署说明.txt "$STAGE/部署说明.txt"
chmod 755 "$STAGE/install.sh" "$STAGE/scripts/bidding" "$STAGE/node/bin/node"
VERSION="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M)-$(git rev-parse --short HEAD) node$NODE_VERSION"
echo "$VERSION" > "$STAGE/VERSION"

tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
echo "version=$VERSION" > "$OUT/build-info-linux.txt"
echo "完成：$OUT/$NAME.tar.gz（$(du -h "$OUT/$NAME.tar.gz" | cut -f1)）"
