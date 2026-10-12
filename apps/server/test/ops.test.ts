import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { EARLY_LOCK, type Ctx, call, control, createFormalEvent, fullRows, importRows, publish, setup, testConfig } from './helpers';

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
    await waitFor(() => readdirSync(backupDir).some((f) => f.includes('round1-published')));
    await control(ctx, eventId, 'wealth', 'START');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    await waitFor(() => readdirSync(backupDir).some((f) => f.includes('locked')));
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

describe('删除活动', () => {
  it('删除活动及其全部数据（含只追加的快照与流水），先生成检查点；竞标中不能删除；其他活动不受影响', async () => {
    const keep = await createFormalEvent(ctx);
    await importRows(ctx, keep, fullRows('wealth'));
    await publish(ctx, keep, 'wealth');
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    await publish(ctx, eventId, 'wealth');
    await control(ctx, eventId, 'wealth', 'START', { groupNo: 1 });
    const del = (body: object) => call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/delete`, { cookie: ctx.adminCookie, body });
    expect((await del({})).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await del({ confirm: true })).body.error.code).toBe('INVALID_STATE');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    // 关联的新活动不受影响（只解除关联）
    const child = await call(ctx.app, 'POST', '/api/v1/admin/events', { cookie: ctx.adminCookie, body: { config: { name: '重建' }, parentEventId: eventId } });
    const ok = await del({ confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(true);
    await waitFor(() => readdirSync(backupDir).some((f) => f.includes('before-delete')));
    for (const t of ['projects', 'bid_states', 'first_round_snapshots', 'result_snapshots', 'audit_logs', 'realtime_events', 'unit_credentials']) {
      const n = await ctx.db.query(`SELECT count(*)::int AS n FROM ${t} WHERE event_id = $1`, [eventId]);
      expect(n.rows[0].n, t).toBe(0);
    }
    expect((await ctx.db.query('SELECT 1 FROM events WHERE id = $1', [eventId])).rowCount).toBe(0);
    const kid = await ctx.db.query('SELECT parent_event_id FROM events WHERE id = $1', [child.body.event.id]);
    expect(kid.rows[0].parent_event_id).toBeNull();
    // 另一个活动的数据完整
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM first_round_snapshot_rows r JOIN first_round_snapshots s ON s.id = r.snapshot_id WHERE s.event_id = $1', [keep])).rows[0].n).toBe(16);
    // 删除记录留在全局审计
    const a = await ctx.db.query(`SELECT details FROM audit_logs WHERE action = 'EVENT_DELETED' AND details->>'eventId' = $1`, [eventId]);
    expect(a.rowCount).toBe(1);
    // 不可变表在平时仍禁止删除
    await expect(ctx.db.query('DELETE FROM first_round_snapshot_rows')).rejects.toThrow(/禁止修改或删除/);
    expect((await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie })).status).toBe(404);
  });
});

describe('关联新活动', () => {
  it('发布后发现数据错误：新建关联原活动的新活动（原因选填）；原活动保留', async () => {
    const eventId = await createFormalEvent(ctx);
    const noReason = await call(ctx.app, 'POST', '/api/v1/admin/events', {
      cookie: ctx.adminCookie,
      body: { config: { name: '重建' }, parentEventId: eventId },
    });
    expect(noReason.status).toBe(201);
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

describe('公网加固', () => {
  it('同一账号连续输错 5 次密码后暂时锁定，正确密码也需等待', async () => {
    const app = (await buildApp(testConfig(), { logger: false })).app;
    try {
      const login = (password: string) =>
        app.inject({ method: 'POST', url: '/api/v1/auth/admin/login', headers: { 'x-bidding-client': '1' }, payload: { username: 'admin', password } });
      for (let i = 0; i < 5; i++) expect((await login('wrong-password')).statusCode).toBe(401);
      const blocked = await login('test-password-123');
      expect(blocked.statusCode).toBe(429);
      expect(JSON.parse(blocked.body).error.code).toBe('TOO_MANY_ATTEMPTS');
    } finally {
      await app.close();
    }
  });

  it('安全响应头；HTTPS 部署时启用 HSTS', async () => {
    const https = (await buildApp(testConfig({ cookieSecure: true }), { logger: false })).app;
    try {
      const r = await https.inject({ method: 'GET', url: '/healthz' });
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['strict-transport-security']).toContain('max-age=');
    } finally {
      await https.close();
    }
    const plain = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(plain.headers['strict-transport-security']).toBeUndefined();
  });
});
