/** 自动检查点：首轮冻结、项目锁定后及删除活动前调用 pg_dump 生成可恢复备份（配置 BACKUP_DIR 时启用） */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import type { Db } from '../db/pool';
import { shanghaiDateCompact } from '../lib/time';

const LABEL_WORDS: Array<[string, string]> = [
  ['首轮发布', 'round1-published'],
  ['项目锁定', 'locked'],
  ['手动检查点', 'manual'],
  ['首轮冻结', 'round1-frozen'],
  ['删除前', 'before-delete'],
];

export function asciiLabel(label: string): string {
  let s = label;
  for (const [zh, en] of LABEL_WORDS) s = s.replace(zh, en);
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'checkpoint';
}

export function makeCheckpointer(config: AppConfig, db: Db, log: (msg: string, err?: unknown) => void) {
  // 返回的 Promise 在检查点完成（或失败已记录）后结束；一般调用方不必等待，删除活动前会等待
  return (eventId: string, label: string): Promise<void> => {
    if (!config.backupDir) return Promise.resolve();
    return (async () => {
      // 文件名只用 ASCII：Windows 非中文区域设置下 pg_dump 无法打开含中文的路径
      const safeLabel = asciiLabel(label);
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
