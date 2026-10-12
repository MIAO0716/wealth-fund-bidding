import { GROUP_BY_NO, type ProjectCode, UNITS } from '@bidding/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { type BuiltApp, buildApp } from '../src/app';
import { type AppConfig, loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { createAdmin } from '../src/services/auth';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bid:bid@localhost:5432/bidding_test';

export const FULL_CONFIG = {
  name: '测试竞标活动',
  year: 2026,
  eventDate: '2099-12-31',
  metricName: '理财销量',
  amountBasis: '销量',
  statPeriod: '活动期',
  dataSource: '测试',
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ DATABASE_URL: TEST_DB_URL, PUBLIC_BASE_URL: 'http://bid.test' }),
    ...overrides,
  };
}

/** 清空测试库并执行迁移 */
export async function resetDb(): Promise<void> {
  if (!/test/.test(new URL(TEST_DB_URL).pathname)) throw new Error('测试数据库名必须包含 test，防止误清空正式库');
  const c = new pg.Client({ connectionString: TEST_DB_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  await db.end();
}

export interface Ctx extends BuiltApp {
  adminCookie: string;
  close: () => Promise<void>;
}

export async function setup(overrides: Partial<AppConfig> = {}, opts: { reset?: boolean } = {}): Promise<Ctx> {
  if (opts.reset !== false) await resetDb();
  const built = await buildApp(testConfig(overrides), { logger: false });
  await built.hub.start();
  await createAdmin(built.db, 'admin', '测试管理员', 'test-password-123');
  const login = await built.app.inject({
    method: 'POST',
    url: '/api/v1/auth/admin/login',
    headers: { 'x-bidding-client': '1' },
    payload: { username: 'admin', password: 'test-password-123' },
  });
  if (login.statusCode !== 200) throw new Error(`登录失败 ${login.body}`);
  const adminCookie = cookieFrom(login.headers['set-cookie']);
  return { ...built, adminCookie, close: () => built.app.close() };
}

export function cookieFrom(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await app.inject({
    method,
    url,
    headers: { 'x-bidding-client': '1', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // 非 JSON
  }
  return { status: res.statusCode, body };
}

let keySeq = 0;
export const idem = (prefix = 'k') => `${prefix}-${Date.now().toString(36)}-${(keySeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function createFormalEvent(ctx: Ctx, config: object = FULL_CONFIG): Promise<string> {
  const r = await call(ctx.app, 'POST', '/api/v1/admin/events', { cookie: ctx.adminCookie, body: { config } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.event.id;
}

/** 生成 16 家合法首轮数据：增幅 = 组别底线 + extra(unit) */
export function fullRows(
  projectCode: ProjectCode,
  opts: { pp?: (code: string, min: number) => number; base?: (code: string) => string } = {},
) {
  return UNITS.map((u) => {
    const min = GROUP_BY_NO.get(u.groupNo)!.minIncreasePp;
    return {
      projectCode,
      unitCode: u.code,
      unitName: u.name,
      baseTargetWan: opts.base ? opts.base(u.code) : '100.00',
      firstRoundIncreasePp: opts.pp ? opts.pp(u.code, min) : min,
    };
  });
}

export async function importRows(ctx: Ctx, eventId: string, rows: object[]) {
  const v = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/validate`, {
    cookie: ctx.adminCookie,
    body: { mode: 'upsert', rows },
  });
  if (v.status !== 200 || !v.body.valid) throw new Error(`校验失败 ${JSON.stringify(v.body).slice(0, 2000)}`);
  const c = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
    cookie: ctx.adminCookie,
    body: { validationId: v.body.validationId, expectedDraftVersion: v.body.draftVersion, idempotencyKey: idem('imp') },
  });
  if (c.status !== 200) throw new Error(`提交失败 ${JSON.stringify(c.body)}`);
  return c.body;
}

export async function getState(ctx: Ctx, eventId: string) {
  return (await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie })).body;
}

export async function publish(ctx: Ctx, eventId: string, projectCode: ProjectCode) {
  const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
  return call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/${projectCode}/publish-first-round`, {
    cookie: ctx.adminCookie,
    body: { expectedDraftVersion: fr.body.projects[projectCode].project.draftVersion, idempotencyKey: idem('pub'), confirm: true },
  });
}

/** 会前准备：理财、基金首轮一起冻结 */
export async function publishAll(ctx: Ctx, eventId: string) {
  const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
  return call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/publish`, {
    cookie: ctx.adminCookie,
    body: { expectedDraftVersion: fr.body.draftVersion, idempotencyKey: idem('pub'), confirm: true },
  });
}

/** 测试中提前收场的锁定（未结束全部分组）：须单独勾选确认 */
export const EARLY_LOCK = { earlyLock: true };

export async function control(
  ctx: Ctx,
  eventId: string,
  projectCode: ProjectCode,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const st = await getState(ctx, eventId);
  return call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/${projectCode}/control`, {
    cookie: ctx.adminCookie,
    body: { action, expectedControlVersion: st.projects[projectCode].controlVersion, idempotencyKey: idem('ctl'), ...extra },
  });
}

/** 发放二维码并用凭证换取单位会话，返回领导端 cookie */
export async function joinUnit(ctx: Ctx, eventId: string, unitCode: string): Promise<string> {
  const issued = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/${unitCode}/credentials`, {
    cookie: ctx.adminCookie,
    body: {},
  });
  const token = new URL(issued.body.joinUrl).hash.replace('#t=', '');
  const ex = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bidder/exchange',
    headers: { 'x-bidding-client': '1' },
    payload: { token },
  });
  if (ex.statusCode !== 200) throw new Error(ex.body);
  return cookieFrom(ex.headers['set-cookie']);
}

export async function joinScreen(ctx: Ctx, eventId: string): Promise<string> {
  const k = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/screen-keys`, { cookie: ctx.adminCookie, body: { label: '主屏' } });
  const key = new URL(k.body.screenUrl).hash.replace('#k=', '');
  const ex = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/screen/exchange', headers: { 'x-bidding-client': '1' }, payload: { key } });
  if (ex.statusCode !== 200) throw new Error(ex.body);
  return cookieFrom(ex.headers['set-cookie']);
}

export async function ack(ctx: Ctx, eventId: string, projectCode: ProjectCode, cookie: string) {
  return call(ctx.app, 'POST', `/api/v1/bidder/events/${eventId}/projects/${projectCode}/base-ack`, {
    cookie,
    body: { idempotencyKey: idem('ack') },
  });
}

export async function me(ctx: Ctx, eventId: string, cookie: string) {
  return (await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie })).body;
}

export async function bid(
  ctx: Ctx,
  eventId: string,
  projectCode: ProjectCode,
  cookie: string,
  body: { targetIncreasePp: unknown; expectedBidVersion: number; idempotencyKey?: string; [k: string]: unknown },
) {
  return call(ctx.app, 'POST', `/api/v1/bidder/events/${eventId}/projects/${projectCode}/bids`, {
    cookie,
    body: { idempotencyKey: idem('bid'), ...body },
  });
}

/** 发布理财首轮并开始，打开指定组 */
export async function goLive(ctx: Ctx, eventId: string, projectCode: ProjectCode, groupNo = 1) {
  const p = await publish(ctx, eventId, projectCode);
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
  const s = await control(ctx, eventId, projectCode, 'START', { groupNo });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
}
