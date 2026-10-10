import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { type Ctx, call, control, createFormalEvent, fullRows, importRows, publish, setup, testConfig } from './helpers';

const backupDir = mkdtempSync(join(tmpdir(), 'bid-backup-'));
let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup({ backupDir });
});
afterAll(async () => {
  await ctx.close();
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('自动检查点', () => {
  it('首轮发布、项目锁定后自动生成可恢复备份', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    await publish(ctx, eventId, 'wealth');
    await waitFor(() => readdirSync(backupDir).some((f) => f.includes('首轮发布')));
    await control(ctx, eventId, 'wealth', 'START');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    await waitFor(() => readdirSync(backupDir).some((f) => f.includes('项目锁定')));
    await waitFor(async () => (await ctx.db.query(`SELECT count(*)::int AS n FROM maintenance_log WHERE action = 'CHECKPOINT'`)).rows[0].n >= 2);
    const m = await call(ctx.app, 'GET', '/api/v1/admin/maintenance', { cookie: ctx.adminCookie });
    expect(m.body.backupEnabled).toBe(true);
    expect(m.body.logs.filter((l: any) => l.action === 'CHECKPOINT').length).toBeGreaterThanOrEqual(2);
    for (const l of m.body.logs) if (l.details.file) expect(existsSync(l.details.file)).toBe(true);
  });
});

describe('只读维护模式', () => {
  it('拒绝写入、允许读取', async () => {
    const eventId = await createFormalEvent(ctx);
    const ro = await buildApp(testConfig({ readOnly: true }), { logger: false });
    try {
      const w = await call(ro.app, 'PATCH', `/api/v1/admin/events/${eventId}/config`, { cookie: ctx.adminCookie, body: { name: 'x' } });
      expect(w.status).toBe(503);
      expect(w.body.error.code).toBe('READ_ONLY');
      const r = await call(ro.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
      expect(r.status).toBe(200);
      const h = await call(ro.app, 'GET', '/healthz');
      expect(h.body.readOnly).toBe(true);
    } finally {
      await ro.app.close();
    }
  });
});

describe('关联新活动', () => {
  it('发布后发现数据错误：新建关联原活动的新活动，须填写原因；原活动保留', async () => {
    const eventId = await createFormalEvent(ctx);
    const noReason = await call(ctx.app, 'POST', '/api/v1/admin/events', {
      cookie: ctx.adminCookie,
      body: { config: { name: '重建' }, parentEventId: eventId },
    });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const ok = await call(ctx.app, 'POST', '/api/v1/admin/events', {
      cookie: ctx.adminCookie,
      body: { config: { name: '重建' }, parentEventId: eventId, parentReason: '浦东底标录错，经组织者确认重建' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.event).toMatchObject({ parentEventId: eventId, parentReason: '浦东底标录错，经组织者确认重建' });
    const list = await call(ctx.app, 'GET', '/api/v1/admin/events', { cookie: ctx.adminCookie });
    expect(list.body.events.map((e: any) => e.id)).toContain(eventId);
    // 正式活动不能归档删除
    const arch = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/archive`, { cookie: ctx.adminCookie, body: {} });
    expect(arch.body.error.code).toBe('DEMO_ONLY');
  });
});
