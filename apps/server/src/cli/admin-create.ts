/**
 * 初始化/重置管理员账号：
 *   npm run admin:create -- --username admin --name 工作人员
 * 密码从环境变量 ADMIN_PASSWORD 读取，未设置时在终端交互输入（不回显），不写入代码或日志。
 */
import { createInterface } from 'node:readline';
import { loadConfig } from '../config';
import { migrate } from '../db/migrate';
import { createPool } from '../db/pool';
import { createAdmin } from '../services/auth';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function askHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => {
    if (s.includes(prompt)) out.output.write(s);
  };
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const username = arg('username') ?? 'admin';
const name = arg('name') ?? '工作人员';
let password = process.env.ADMIN_PASSWORD ?? '';
if (!password) {
  password = await askHidden(`请输入 ${username} 的密码（至少 10 位）：`);
  const again = await askHidden('请再次输入：');
  if (again !== password) {
    console.error('两次输入不一致');
    process.exit(1);
  }
}
const db = createPool(loadConfig().databaseUrl);
try {
  await migrate(db);
  await createAdmin(db, username, name, password);
  console.log(`管理员 ${username}（${name}）已创建/更新`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
