/** 运行配置：全部来自环境变量，见仓库根目录 .env.example */

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  /** 对外访问地址（二维码使用），例如 https://bid.example.com 或 http://192.168.1.10:8080 */
  publicBaseUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  /** 只读维护模式：拒绝所有写入（恢复备份时使用） */
  readOnly: boolean;
  /** 自动检查点目录；为空则不自动备份 */
  backupDir: string;
  pgDumpPath: string;
  webDist: string;
  logLevel: string;
  adminSessionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('缺少环境变量 DATABASE_URL');
  const port = Number(env.PORT ?? 8080);
  return {
    databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    cookieSecure: bool(env.COOKIE_SECURE, (env.PUBLIC_BASE_URL ?? '').startsWith('https://')),
    trustProxy: bool(env.TRUST_PROXY, false),
    readOnly: bool(env.READ_ONLY, false),
    backupDir: env.BACKUP_DIR ?? '',
    pgDumpPath: env.PG_DUMP_PATH ?? 'pg_dump',
    webDist: env.WEB_DIST ?? '',
    logLevel: env.LOG_LEVEL ?? 'info',
    adminSessionHours: Number(env.ADMIN_SESSION_HOURS ?? 12),
  };
}
