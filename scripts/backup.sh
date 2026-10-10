#!/usr/bin/env bash
# 手动备份：生成可恢复的 pg_dump 检查点并校验可读。
# 用法：DATABASE_URL=postgres://... BACKUP_DIR=./backups scripts/backup.sh [标签]
set -euo pipefail
: "${DATABASE_URL:?请设置 DATABASE_URL}"
DIR="${BACKUP_DIR:-./backups}"
LABEL="${1:-manual}"
mkdir -p "$DIR"
FILE="$DIR/${LABEL}-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S).dump"
pg_dump -Fc -f "$FILE" "$DATABASE_URL"
# 校验备份文件可被 pg_restore 读取
pg_restore -l "$FILE" > /dev/null
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c \
  "INSERT INTO maintenance_log (action, details) VALUES ('CHECKPOINT', jsonb_build_object('label', '${LABEL//\'/}', 'file', '${FILE//\'/}', 'by', 'scripts/backup.sh'))" > /dev/null
echo "备份完成：$FILE"
