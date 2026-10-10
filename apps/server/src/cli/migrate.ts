import { loadConfig } from '../config';
import { migrate } from '../db/migrate';
import { createPool } from '../db/pool';

const db = createPool(loadConfig().databaseUrl);
try {
  const applied = await migrate(db, undefined, (m) => console.log(m));
  console.log(applied.length ? `完成，共执行 ${applied.length} 个迁移` : '数据库已是最新');
} finally {
  await db.end();
}
