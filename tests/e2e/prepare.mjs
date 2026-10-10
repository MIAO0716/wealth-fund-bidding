// E2E 准备：清空独立的 E2E 数据库、执行迁移、创建管理员。切勿指向正式库。
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url || !/e2e/.test(url)) {
  console.error('E2E 数据库名必须包含 e2e，防止误清空正式库');
  process.exit(1);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
execFileSync('node', ['apps/server/dist/migrate.js'], { stdio: 'inherit' });
execFileSync('node', ['apps/server/dist/admin-create.js', '--username', 'admin', '--name', '现场工作人员'], { stdio: 'inherit' });
