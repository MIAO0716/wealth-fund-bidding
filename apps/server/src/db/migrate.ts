import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool';

export function defaultMigrationsDir(): string {
  // 源码运行：src/db → ../../migrations；打包运行：dist → ../migrations
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.MIGRATIONS_DIR ?? (here.endsWith('dist') ? join(here, '..', 'migrations') : join(here, '..', '..', 'migrations'));
}

/** 按文件名顺序执行未执行过的 .sql 迁移，每个文件一个事务 */
export async function migrate(db: Db, dir = defaultMigrationsDir(), log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // 防止多个进程同时迁移
      await client.query('SELECT pg_advisory_xact_lock(724001)');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) {
        await client.query('COMMIT');
        continue;
      }
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`已执行迁移 ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
