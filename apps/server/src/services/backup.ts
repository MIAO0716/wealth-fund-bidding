/** 自动检查点：首轮发布、项目锁定后调用 pg_dump 生成可恢复备份（配置 BACKUP_DIR 时启用） */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import type { Db } from '../db/pool';
import { shanghaiDateCompact } from '../lib/time';

export function makeCheckpointer(config: AppConfig, db: Db, log: (msg: string, err?: unknown) => void) {
  return (eventId: string, label: string) => {
    if (!config.backupDir) return;
    void (async () => {
      const safeLabel = label.replace(/[^\p{L}\p{N}_-]/gu, '_');
      const file = join(config.backupDir, `checkpoint-${shanghaiDateCompact()}-${eventId.slice(0, 8)}-${safeLabel}.dump`);
      try {
        await mkdir(config.backupDir, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const p = spawn(config.pgDumpPath, ['-Fc', '-f', file, config.databaseUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          p.stderr.on('data', (d) => (stderr += d));
          p.on('error', reject);
          p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump 退出码 ${code}: ${stderr.slice(0, 500)}`))));
        });
        await db.query(`INSERT INTO maintenance_log (action, details) VALUES ('CHECKPOINT', $1)`, [
          JSON.stringify({ eventId, label, file }),
        ]);
        log(`已生成检查点 ${file}`);
      } catch (err) {
        log(`生成检查点失败（${label}），请手动备份`, err);
        await db
          .query(`INSERT INTO maintenance_log (action, details) VALUES ('CHECKPOINT_FAILED', $1)`, [
            JSON.stringify({ eventId, label, error: String(err) }),
          ])
          .catch(() => {});
      }
    })();
  };
}
