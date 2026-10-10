import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Ctx,
  ack,
  bid,
  call,
  control,
  createFormalEvent,
  fullRows,
  getState,
  goLive,
  idem,
  importRows,
  joinScreen,
  joinUnit,
  me,
  publish,
  setup,
} from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.close();
});

/** 准备：两项目数据齐全，PD 首轮 30%，理财开始并开放第一组，PD 已确认底标 */
async function liveEvent(opts: { pdPp?: number } = {}) {
  const eventId = await createFormalEvent(ctx);
  await importRows(ctx, eventId, [
    ...fullRows('wealth', { pp: (c, m) => (c === 'PD' ? (opts.pdPp ?? 30) : m) }),
    ...fullRows('fund', { base: () => '200' }),
  ]);
  await goLive(ctx, eventId, 'wealth', 1);
  const pd = await joinUnit(ctx, eventId, 'PD');
  expect((await ack(ctx, eventId, 'wealth', pd)).status).toBe(200);
  return { eventId, pd };
}

const pdState = async (eventId: string, cookie: string) => (await me(ctx, eventId, cookie)).projects.wealth;

describe('A07 发布理财首轮', () => {
  it('三组首轮榜；冻结快照；当前增幅从首轮起算', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m) }));
    const screen = await joinScreen(ctx, eventId);
    const pub = await publish(ctx, eventId, 'wealth');
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('ROUND1_PUBLISHED');
    const sf = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/projects/wealth/first-round`, { cookie: screen });
    expect(sf.body.board.published).toBe(true);
    expect(sf.body.board.completeCount).toBe(16);
    expect(sf.body.board.groups.map((g: any) => g.rows.length)).toEqual([6, 5, 5]);
    expect(sf.body.board.groups[0].rows[0]).toMatchObject({ unitCode: 'PD', firstRoundPp: 30, rank: 1 });
    // 默认大屏不展示金额
    expect(sf.body.board.groups[0].rows[0].baseTargetWan).toBeUndefined();
    const st = await getState(ctx, eventId);
    expect(st.boards.wealth[0].rows.find((r: any) => r.unitCode === 'PD')).toMatchObject({ firstRoundPp: 30, currentPp: 30 });
    // 重复发布被拒绝
    expect((await publish(ctx, eventId, 'wealth')).status).toBe(422);
    // 快照不可在数据库层被修改
    await expect(ctx.db.query(`UPDATE first_round_snapshot_rows SET first_round_pp = 50`)).rejects.toThrow(/禁止修改/);
  });
});

describe('A08/A09 追加', () => {
  it('30% +5 → 35%，目标 = 底标 × 1.35；大屏跟随更新', async () => {
    const { eventId, pd } = await liveEvent();
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ unitCode: 'PD', fromPp: 30, toPp: 35, deltaPp: 5, targetWan: '135.00', targetFen: '135000000', bidVersion: 1 });
    expect(r.body.receipt.eventSequence).toBeGreaterThan(0);
    const screen = await joinScreen(ctx, eventId);
    const live = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    expect(live.body.groups[0].rows[0]).toMatchObject({ unitCode: 'PD', currentPp: 35, firstRoundPp: 30 });
    expect(live.body.recentBids[0]).toMatchObject({ unitName: '浦东', fromPp: 30, toPp: 35 });
  });

  it('30% +10 → 40%；切换为仅 +5 后同样请求被拒绝', async () => {
    const { eventId, pd } = await liveEvent();
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 0 });
    expect(r.status).toBe(201);
    expect(r.body.receipt.toPp).toBe(40);
    const cfg = await call(ctx.app, 'PATCH', `/api/v1/admin/events/${eventId}/config`, {
      cookie: ctx.adminCookie,
      body: { allowedIncrementSteps: [5] },
    });
    expect(cfg.status).toBe(200);
    const r2 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 50, expectedBidVersion: 1 });
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('INVALID_STEP');
    const r3 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 45, expectedBidVersion: 1 });
    expect(r3.status).toBe(201);
  });
});

describe('A10 篡改请求', () => {
  it('32%、30%、25%、不允许差值均被服务端拒绝', async () => {
    const { eventId, pd } = await liveEvent();
    for (const [target, code] of [
      [32, 'INVALID_STEP'],
      [30, 'NOT_GREATER'],
      [25, 'NOT_GREATER'],
      [55, 'INVALID_STEP'],
      ['35', 'INVALID_VALUE'],
      [35.5, 'INVALID_VALUE'],
    ] as const) {
      const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: target, expectedBidVersion: 0 });
      expect(r.status, `target ${target}`).toBe(422);
      expect(r.body.error.code, `target ${target}`).toBe(code);
    }
    expect((await pdState(eventId, pd)).currentPp).toBe(30);
  });

  it('增幅较大时需要再次明确确认（不是上限）', async () => {
    const { eventId, pd } = await liveEvent({ pdPp: 95 });
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 100, expectedBidVersion: 0 });
    expect(r.body.error.code).toBe('HIGH_VALUE_CONFIRM_REQUIRED');
    const r2 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 100, expectedBidVersion: 0, confirmHighValue: true });
    expect(r2.status).toBe(201);
  });
});

describe('A11 首轮与现场分离', () => {
  it('首轮页仍 30%，实时 40%，累计加码 10 个百分点', async () => {
    const { eventId, pd } = await liveEvent();
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 1 });
    const screen = await joinScreen(ctx, eventId);
    const sf = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/projects/wealth/first-round`, { cookie: screen });
    expect(sf.body.board.groups[0].rows.find((r: any) => r.unitCode === 'PD').firstRoundPp).toBe(30);
    const st = await pdState(eventId, pd);
    expect(st).toMatchObject({ firstRoundPp: 30, currentPp: 40 });
    expect(st.currentPp - st.firstRoundPp).toBe(10);
  });
});

describe('A12 两部手机同时由 30% 报 35%', () => {
  it('一次成功，另一次冲突；最终 35%，流水仅一条', async () => {
    const { eventId, pd } = await liveEvent();
    // 同单位第二部手机：重新发放二维码但不撤销旧会话 → 新会话登录会撤销旧会话（默认单会话）
    // 为模拟两部手机并发，这里两个请求共用同一会话但不同幂等键
    const [a, b] = await Promise.all([
      bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 }),
      bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');
    expect(conflict.body.error.details).toMatchObject({ currentPp: 35, bidVersion: 1 });
    expect((await pdState(eventId, pd)).currentPp).toBe(35);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('10 个并发请求只有 1 个成功', async () => {
    const { eventId, pd } = await liveEvent();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await pdState(eventId, pd)).currentPp).toBe(35);
  });
});

describe('A13 连点或同幂等键重试', () => {
  it('只记一笔，返回原回执；不同内容同键报错', async () => {
    const { eventId, pd } = await liveEvent();
    const key = idem('same');
    const [a, b] = await Promise.all([
      bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: key }),
      bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: key }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.receipt.bidId).toBe(b.body.receipt.bidId);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    const diff = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 0, idempotencyKey: key });
    expect(diff.status).toBe(409);
    expect(diff.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('A14 成功但响应丢失，随后项目锁定', () => {
  it('回执查询与同键重试仍确认原成功，不再次加码', async () => {
    const { eventId, pd } = await liveEvent();
    const key = idem('lost');
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: key });
    expect((await control(ctx, eventId, 'wealth', 'PAUSE')).status).toBe(200);
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).status).toBe(200);
    const q = await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/requests/${key}`, { cookie: pd });
    expect(q.body).toMatchObject({ found: true, status: 'SUCCEEDED' });
    expect(q.body.response.toPp).toBe(35);
    const retry = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: key });
    expect(retry.status).toBe(201);
    expect(retry.body.replayed).toBe(true);
    expect((await pdState(eventId, pd)).currentPp).toBe(35);
    // 新请求在锁定后被拒绝
    const fresh = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 1 });
    expect(fresh.body.error.code).toBe('PROJECT_LOCKED');
    // 未到达服务器的请求
    const none = await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/requests/${idem('none')}`, { cookie: pd });
    expect(none.body).toMatchObject({ found: false, status: 'NOT_FOUND' });
  });
});

describe('A15 锁定与加码并发', () => {
  it('结果符合事务先后；锁定后无新成交', async () => {
    for (let round = 0; round < 5; round++) {
      const { eventId, pd } = await liveEvent();
      await control(ctx, eventId, 'wealth', 'PAUSE');
      await control(ctx, eventId, 'wealth', 'RESUME');
      const st = await getState(ctx, eventId);
      // 锁定须从暂停执行：并发「暂停→锁定」与加码
      const pauseThenLock = (async () => {
        const p = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/control`, {
          cookie: ctx.adminCookie,
          body: { action: 'PAUSE', expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: idem() },
        });
        return call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/control`, {
          cookie: ctx.adminCookie,
          body: { action: 'LOCK', confirm: true, expectedControlVersion: p.body.controlVersion, idempotencyKey: idem() },
        });
      })();
      const bidP = bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
      const [lockRes, bidRes] = await Promise.all([pauseThenLock, bidP]);
      expect(lockRes.status).toBe(200);
      const snap = await ctx.db.query(
        `SELECT r.final_pp, s.event_sequence FROM result_snapshot_rows r JOIN result_snapshots s ON s.id = r.snapshot_id
          WHERE s.event_id = $1 AND r.unit_code = 'PD'`,
        [eventId],
      );
      if (bidRes.status === 201) {
        // 成交在锁定之前：锁定快照必须包含它
        expect(bidRes.body.receipt.eventSequence).toBeLessThan(Number(snap.rows[0].event_sequence));
        expect(snap.rows[0].final_pp).toBe(35);
      } else {
        expect(['PROJECT_PAUSED', 'PROJECT_LOCKED']).toContain(bidRes.body.error.code);
        expect(snap.rows[0].final_pp).toBe(30);
      }
      const late = await ctx.db.query(
        `SELECT count(*)::int AS n FROM bid_records b JOIN result_snapshots s ON s.event_id = b.event_id AND s.project_code = b.project_code
          WHERE b.event_id = $1 AND b.event_sequence > s.event_sequence`,
        [eventId],
      );
      expect(late.rows[0].n).toBe(0);
    }
  });
});

describe('A16 暂停、非当前组、底标未确认', () => {
  it('均按对应原因拒绝', async () => {
    const { eventId, pd } = await liveEvent();
    // 第二组未开放
    const hp = await joinUnit(ctx, eventId, 'HP');
    await ack(ctx, eventId, 'wealth', hp);
    const r1 = await bid(ctx, eventId, 'wealth', hp, { targetIncreasePp: 15, expectedBidVersion: 0 });
    expect(r1.body.error.code).toBe('GROUP_NOT_OPEN');
    // 底标未确认
    const mh = await joinUnit(ctx, eventId, 'MH');
    const r2 = await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 10, expectedBidVersion: 0 });
    expect(r2.body.error.code).toBe('BASE_NOT_ACKNOWLEDGED');
    // 其他单位未确认不阻塞已确认单位
    expect((await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 })).status).toBe(201);
    // 暂停
    await control(ctx, eventId, 'wealth', 'PAUSE');
    const r3 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 1 });
    expect(r3.body.error.code).toBe('PROJECT_PAUSED');
    // 关闭组后
    await control(ctx, eventId, 'wealth', 'RESUME');
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    const r4 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 1 });
    expect(r4.body.error.code).toBe('GROUP_NOT_OPEN');
    // 失败提交进入监控
    const mon = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/monitor`, { cookie: ctx.adminCookie });
    expect(mon.body.failures.map((f: any) => f.errorCode)).toEqual(
      expect.arrayContaining(['GROUP_NOT_OPEN', 'BASE_NOT_ACKNOWLEDGED', 'PROJECT_PAUSED']),
    );
  });

  it('项目未开始、首轮未发布时提示未开放', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    const pd = await joinUnit(ctx, eventId, 'PD');
    const a = await ack(ctx, eventId, 'wealth', pd);
    expect(a.body.error.code).toBe('PROJECT_NOT_ACTIVE');
    await publish(ctx, eventId, 'wealth');
    expect((await ack(ctx, eventId, 'wealth', pd)).status).toBe(200);
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 10, expectedBidVersion: 0 });
    expect(r.body.error.code).toBe('PROJECT_NOT_ACTIVE');
  });
});

describe('A17 浦东改请求冒充闵行', () => {
  it('无法替其他单位报价或读未公开资料', async () => {
    const { eventId, pd } = await liveEvent();
    const mh = await joinUnit(ctx, eventId, 'MH');
    await ack(ctx, eventId, 'wealth', mh);
    // 请求体夹带 unitCode 被忽略：报价记在浦东名下
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, unitCode: 'MH' });
    expect(r.status).toBe(201);
    expect(r.body.receipt.unitCode).toBe('PD');
    expect((await me(ctx, eventId, mh)).projects.wealth.currentPp).toBe(5);
    // 领导会话不能访问管理接口、其他活动
    const adminTry = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: pd });
    expect(adminTry.status).toBe(401);
    const other = await createFormalEvent(ctx);
    const otherTry = await call(ctx.app, 'GET', `/api/v1/bidder/events/${other}/me`, { cookie: pd });
    expect(otherTry.status).toBe(401);
    // 领导端快照只含本单位
    const mine = await me(ctx, eventId, pd);
    expect(JSON.stringify(mine)).not.toMatch(/"MH"|闵行/);
  });

  it('一次性凭证不可重复使用；新会话登录后旧会话失效', async () => {
    const eventId = await createFormalEvent(ctx);
    const issued = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/credentials`, { cookie: ctx.adminCookie, body: {} });
    const token = new URL(issued.body.joinUrl).hash.replace('#t=', '');
    const ex = () => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/bidder/exchange', headers: { 'x-bidding-client': '1' }, payload: { token } });
    const first = await ex();
    expect(first.statusCode).toBe(200);
    const second = await ex();
    expect(second.statusCode).toBe(401);
    expect(JSON.parse(second.body).error.code).toBe('CREDENTIAL_INVALID');
    const oldCookie = first.headers['set-cookie'] as string;
    const newCookie = await joinUnit(ctx, eventId, 'PD');
    const oldMe = await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: oldCookie.split(';')[0] });
    expect(oldMe.status).toBe(401);
    expect(oldMe.body.error.code).toBe('SESSION_INVALID');
    expect((await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: newCookie })).status).toBe(200);
  });

  it('缺少客户端请求头的写请求被拒绝', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/admin/login', payload: { username: 'admin', password: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('A18 理财未锁定时开启基金', () => {
  it('拒绝；理财锁定后基金可以发布和开始', async () => {
    const { eventId } = await liveEvent();
    const early = await publish(ctx, eventId, 'fund');
    expect(early.body.error.code).toBe('PROJECT_ORDER');
    for (const g of [1, 2, 3]) {
      if (g > 1) await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: g });
      await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: g });
    }
    // 结束最后一组自动暂停
    expect((await getState(ctx, eventId)).projects.wealth.status).toBe('PAUSED');
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).status).toBe(200);
    const pub = await publish(ctx, eventId, 'fund');
    expect(pub.status).toBe(200);
    const st = await control(ctx, eventId, 'fund', 'START', { groupNo: 1 });
    expect(st.status).toBe(200);
    // 理财首轮快照不受基金影响
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.snapshot).not.toBeNull();
    expect(fr.body.projects.fund.draftRows[0].baseTargetWan).toBe('200.00');
  });

  it('非法状态转换被拒绝：锁定须先暂停；锁定后不可恢复', async () => {
    const { eventId } = await liveEvent();
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).body.error.code).toBe('INVALID_STATE');
    expect((await control(ctx, eventId, 'wealth', 'LOCK')).body.error.code).toBe('CONFIRM_REQUIRED');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    expect((await control(ctx, eventId, 'wealth', 'RESUME')).body.error.code).toBe('PROJECT_LOCKED');
  });

  it('控制版本过期被拒绝', async () => {
    const { eventId } = await liveEvent();
    const st = await getState(ctx, eventId);
    const body = { action: 'PAUSE', expectedControlVersion: st.projects.wealth.controlVersion - 1, idempotencyKey: idem() };
    const r = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/control`, { cookie: ctx.adminCookie, body });
    expect(r.body.error.code).toBe('CONTROL_VERSION_CONFLICT');
  });

  it('同时最多一个开放组；重新开放已结束组需理由且不下调', async () => {
    const { eventId, pd } = await liveEvent();
    expect((await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 2 })).body.error.message).toContain('第1组仍在进行');
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    expect((await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 1 })).body.error.code).toBe('REASON_REQUIRED');
    expect((await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 1, reason: '并列第一组织追加' })).status).toBe(200);
    expect((await pdState(eventId, pd)).currentPp).toBe(35);
  });
});

describe('A19/A20 标王门槛与并列', () => {
  async function groupWith(pps: Record<string, number>) {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth', { pp: (c, m) => pps[c] ?? m }));
    await publish(ctx, eventId, 'wealth');
    return eventId;
  }

  it('A19 同组最高 25%：组内领先，无标王候选', async () => {
    const eventId = await groupWith({ PD: 25, MH: 20 });
    const st = await getState(ctx, eventId);
    expect(st.boards.wealth[0]).toMatchObject({ leaderStatus: 'GROUP_LEADER', topPp: 25, topUnitCodes: ['PD'] });
  });

  it('A20 两家 35%、第三家 30%：名次 1、1、3；并列待确认', async () => {
    const eventId = await groupWith({ PD: 35, MH: 35, BS: 30 });
    const st = await getState(ctx, eventId);
    const g = st.boards.wealth[0];
    expect(g.rows.slice(0, 3).map((r: any) => [r.unitCode, r.rank])).toEqual([
      ['PD', 1],
      ['MH', 1],
      ['BS', 3],
    ]);
    expect(g.leaderStatus).toBe('TIED_PENDING');
    // 锁定保留并列事实并提示
    await control(ctx, eventId, 'wealth', 'START');
    const preview = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/projects/wealth/lock-preview`, { cookie: ctx.adminCookie });
    expect(preview.body.tieWarnings[0].message).toContain('授旗规则未确认');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    const lock = await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    expect(lock.body.tieWarnings).toHaveLength(1);
    const screen = await joinScreen(ctx, eventId);
    const res = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/results`, { cookie: screen });
    const g1 = res.body.projects.wealth.groups[0];
    expect(g1.rows.filter((r: any) => r.leaderLabel === '现场标王')).toHaveLength(0);
    expect(g1.rows[0].leaderLabel).toContain('待确认');
    expect(res.body.projects.fund.locked).toBe(false);
  });

  it('唯一第一且 ≥30%：锁定后显示现场标王', async () => {
    const eventId = await groupWith({ PD: 30 });
    await control(ctx, eventId, 'wealth', 'START');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    const st = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
    expect(st.body.projects.wealth.status).toBe('LOCKED');
    const screen = await joinScreen(ctx, eventId);
    const res = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/results`, { cookie: screen });
    expect(res.body.projects.wealth.groups[0].rows[0]).toMatchObject({ unitCode: 'PD', leaderLabel: '现场标王', rank: 1 });
    // 第二组最高 10%：组内领先
    expect(res.body.projects.wealth.groups[1].leaderStatus).toBe('GROUP_LEADER');
  });
});

describe('A23 管理员代录', () => {
  it('同等校验，标明代录来源与原因，不能下调', async () => {
    const { eventId } = await liveEvent();
    const proxy = (body: object) =>
      call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/bids`, { cookie: ctx.adminCookie, body });
    // 底标未确认
    expect((await proxy({ targetIncreasePp: 10, expectedBidVersion: 0, idempotencyKey: idem(), reason: '断网代录' })).body.error.code).toBe(
      'BASE_NOT_ACKNOWLEDGED',
    );
    // 代记底标确认须注明原因
    const ackNoReason = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/base-ack`, {
      cookie: ctx.adminCookie,
      body: { idempotencyKey: idem() },
    });
    expect(ackNoReason.body.error.code).toBe('REASON_REQUIRED');
    const ackOk = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/base-ack`, {
      cookie: ctx.adminCookie,
      body: { idempotencyKey: idem(), reason: '领导现场口头确认' },
    });
    expect(ackOk.body.source).toBe('ADMIN_PROXY');
    // 必须填写原因
    expect((await proxy({ targetIncreasePp: 10, expectedBidVersion: 0, idempotencyKey: idem() })).body.error.code).toBe('REASON_REQUIRED');
    // 不能下调
    expect((await proxy({ targetIncreasePp: 5, expectedBidVersion: 0, idempotencyKey: idem(), reason: 'x' })).body.error.code).toBe('NOT_GREATER');
    const ok = await proxy({ targetIncreasePp: 15, expectedBidVersion: 0, idempotencyKey: idem(), reason: '手机没电，领导口头确认' });
    expect(ok.status).toBe(201);
    expect(ok.body.receipt).toMatchObject({ source: 'ADMIN_PROXY', fromPp: 5, toPp: 15, deltaPp: 10 });
    const rec = await ctx.db.query(`SELECT source, reason, actor_type FROM bid_records WHERE event_id = $1 AND unit_code = 'MH'`, [eventId]);
    expect(rec.rows[0]).toMatchObject({ source: 'ADMIN_PROXY', reason: '手机没电，领导口头确认', actor_type: 'ADMIN' });
    // 数据库层兜底：直接 UPDATE 下调被拒绝
    await expect(
      ctx.db.query(`UPDATE bid_states SET current_pp = 5 WHERE event_id = $1 AND project_code = 'wealth' AND unit_code = 'MH'`, [eventId]),
    ).rejects.toThrow(/不能下调/);
  });
});

describe('演示活动隔离', () => {
  it('演示活动自动填充演示数据并标记；正式活动不能填充演示数据', async () => {
    const d = await call(ctx.app, 'POST', '/api/v1/admin/events', { cookie: ctx.adminCookie, body: { isDemo: true } });
    expect(d.status).toBe(201);
    expect(d.body.event.isDemo).toBe(true);
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${d.body.event.id}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.preview.completeCount).toBe(16);
    const formal = await createFormalEvent(ctx);
    const seed = await call(ctx.app, 'POST', `/api/v1/admin/events/${formal}/demo/seed`, { cookie: ctx.adminCookie, body: {} });
    expect(seed.body.error.code).toBe('DEMO_ONLY');
  });
});
