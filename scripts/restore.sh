#!/usr/bin/env bash
# 从检查点恢复。必须在停写状态下执行：先停止应用，或以 READ_ONLY=true 重启应用。
# 恢复后：所有领导与大屏会话、未使用的二维码统一作废（防止旧会话继续报价），并写入恢复记录。
# 用法：DATABASE_URL=postgres://... scripts/restore.sh backups/xxx.dump
set -euo pipefail
FILE="${1:?用法：scripts/restore.sh <备份文件>}"
: "${DATABASE_URL:?请设置 DATABASE_URL}"
[ -f "$FILE" ] || { echo "备份文件不存在：$FILE"; exit 1; }
pg_restore -l "$FILE" > /dev/null

echo "即将用 $FILE 覆盖数据库中的全部数据。"
echo "请确认：1) 应用已停止或处于 READ_ONLY=true 只读模式；2) 已通知现场暂停操作。"
if [ "${CONFIRM:-}" != "RESTORE" ]; then
  read -r -p "输入 RESTORE 继续：" ans
  [ "$ans" = "RESTORE" ] || { echo "已取消"; exit 1; }
fi

DIR="${BACKUP_DIR:-$(dirname "$FILE")}"
mkdir -p "$DIR"
BEFORE="$DIR/before-restore-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S).dump"
pg_dump -Fc -f "$BEFORE" "$DATABASE_URL"
echo "已先备份当前数据：$BEFORE"

pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" "$FILE"

psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<SQL
UPDATE sessions SET revoked_at = now(), revoke_reason = '备份恢复后统一失效'
 WHERE role IN ('BIDDER', 'SCREEN') AND revoked_at IS NULL;
UPDATE unit_credentials SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL;
INSERT INTO maintenance_log (action, details)
VALUES ('RESTORE', jsonb_build_object('file', '${FILE//\'/}', 'before', '${BEFORE//\'/}'));
SQL
echo "恢复完成。下一步：以正常模式重启应用，在管理端重新发放 16 家二维码并重新打开大屏链接。"
