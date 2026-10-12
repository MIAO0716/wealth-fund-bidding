import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EARLY_LOCK,
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
  publishAll,
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
  // 会前一起冻结理财、基金首轮，现场开始理财第一组
  expect((await publishAll(ctx, eventId)).status).toBe(200);
  expect((await control(ctx, eventId, 'wealth', 'START', { groupNo: 1 })).status).toBe(200);
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
    // 默认大屏展示底标与目标金额
    expect(sf.body.board.groups[0].rows[0]).toMatchObject({ baseTargetWan: '100.00', targetWan: '130.00' });
    const st = await getState(ctx, eventId);
    expect(st.boards.wealth[0].rows.find((r: any) => r.unitCode === 'PD')).toMatchObject({ firstRoundPp: 30, currentPp: 30 });
    // 重复发布被拒绝
    expect((await publish(ctx, eventId, 'wealth')).status).toBe(422);
    // 快照不可在数据库层被修改
    await expect(ctx.db.query(`UPDATE first_round_snapshot_rows SET first_round_pp = 50`)).rejects.toThrow(/禁止修改/);
  });
});

describe('会前准备：理财、基金首轮一起冻结', () => {
  it('任一项目不完整则都不冻结；完整后一起冻结，当前专场为理财，大屏切到理财首轮', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    const partial = await publishAll(ctx, eventId);
    expect(partial.body.error.code).toBe('ROUND1_INCOMPLETE');
    expect(partial.body.error.details.problems[0]).toContain('基金：');
    const st0 = await getState(ctx, eventId);
    expect([st0.projects.wealth.status, st0.projects.fund.status]).toEqual(['DRAFT', 'DRAFT']);
    await importRows(ctx, eventId, fullRows('fund', { base: () => '200' }));
    // 草稿版本过期被拒绝
    const stale = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/publish`, {
      cookie: ctx.adminCookie,
      body: { expectedDraftVersion: 0, idempotencyKey: idem('pub'), confirm: true },
    });
    expect(stale.body.error.code).toBe('DRAFT_VERSION_CONFLICT');
    const ok = await publishAll(ctx, eventId);
    expect(ok.status).toBe(200);
    expect(ok.body.published.map((x: any) => x.projectCode)).toEqual(['wealth', 'fund']);
    const st = await getState(ctx, eventId);
    expect([st.projects.wealth.status, st.projects.fund.status]).toEqual(['ROUND1_PUBLISHED', 'ROUND1_PUBLISHED']);
    expect(st.event).toMatchObject({ currentProject: 'wealth', screenMode: 'FIRST_ROUND', screenProject: 'wealth' });
    // 领导可在会前分别认领理财、基金底标
    const pd = await joinUnit(ctx, eventId, 'PD');
    expect((await ack(ctx, eventId, 'wealth', pd)).status).toBe(200);
    expect((await ack(ctx, eventId, 'fund', pd)).status).toBe(200);
    expect((await publishAll(ctx, eventId)).body.error.code).toBe('INVALID_STATE');
  });

  it('只需活动名称与日期即可冻结（不再要求指标名称、口径、周期、说明）', async () => {
    const eventId = await createFormalEvent(ctx, { name: '极简配置', eventDate: '2099-12-31' });
    await importRows(ctx, eventId, [...fullRows('wealth'), ...fullRows('fund')]);
    expect((await publishAll(ctx, eventId)).status).toBe(200);
    const st = await getState(ctx, eventId);
    expect(st.event.config).toMatchObject({ year: 2099, showAmountsOnScreen: true });
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

  it('每次加码为 1 的整数倍：30% +1 → 31%、+12 → 43%；快捷档位只影响按钮，不限制加码', async () => {
    const { eventId, pd } = await liveEvent();
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 31, expectedBidVersion: 0 });
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ fromPp: 30, toPp: 31, deltaPp: 1 });
    const cfg = await call(ctx.app, 'PATCH', `/api/v1/admin/events/${eventId}/config`, {
      cookie: ctx.adminCookie,
      body: { allowedIncrementSteps: [5] },
    });
    expect(cfg.status).toBe(200);
    const r2 = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 43, expectedBidVersion: 1 });
    expect(r2.status).toBe(201);
    expect(r2.body.receipt).toMatchObject({ fromPp: 31, toPp: 43, deltaPp: 12 });
  });
});

describe('A10 篡改请求', () => {
  it('等于或低于当前值、文本、小数均被服务端拒绝', async () => {
    const { eventId, pd } = await liveEvent();
    for (const [target, code] of [
      [30, 'NOT_GREATER'],
      [25, 'NOT_GREATER'],
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
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK })).status).toBe(200);
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
          body: { action: 'LOCK', confirm: true, ...EARLY_LOCK, expectedControlVersion: p.body.controlVersion, idempotencyKey: idem() },
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
    expect((await me(ctx, eventId, mh)).projects.wealth.currentPp).toBe(10);
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

  it('二维码可重复扫码；同一时间一部手机在线：新手机登录后旧手机下线', async () => {
    const eventId = await createFormalEvent(ctx);
    const issued = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/credentials`, { cookie: ctx.adminCookie, body: {} });
    const token = new URL(issued.body.joinUrl).hash.replace('#t=', '');
    const ex = () => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/bidder/exchange', headers: { 'x-bidding-client': '1' }, payload: { token } });
    const first = await ex();
    expect(first.statusCode).toBe(200);
    const oldCookie = (first.headers['set-cookie'] as string).split(';')[0];
    // 换手机：同一二维码再次扫码成功，旧手机下线
    const second = await ex();
    expect(second.statusCode).toBe(200);
    const newCookie = (second.headers['set-cookie'] as string).split(';')[0];
    const oldMe = await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: oldCookie });
    expect(oldMe.status).toBe(401);
    expect(oldMe.body.error.code).toBe('SESSION_INVALID');
    expect(oldMe.body.error.message).toContain('另一部手机');
    expect((await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: newCookie })).status).toBe(200);
    const units = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/units`, { cookie: ctx.adminCookie });
    expect(units.body.units.find((u: any) => u.unitCode === 'PD')).toMatchObject({ credentialStatus: 'USED', activeSessions: 1 });

    // 强制下线：当前手机下线，二维码继续有效
    const kick = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/kick`, { cookie: ctx.adminCookie, body: {} });
    expect(kick.body.kickedSessions).toBe(1);
    expect((await call(ctx.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: newCookie })).status).toBe(401);
    expect((await ex()).statusCode).toBe(200);

    // 二维码活动期间固定不变：再次显示得到同一个二维码
    const again = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/credentials`, { cookie: ctx.adminCookie, body: {} });
    expect(again.body.joinUrl).toBe(issued.body.joinUrl);
    const batch = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/credentials/batch`, { cookie: ctx.adminCookie, body: {} });
    expect(batch.body.credentials.find((c: any) => c.unitCode === 'PD').joinUrl).toBe(issued.body.joinUrl);
    expect(batch.body.credentials).toHaveLength(16);
    // 有效期至少覆盖活动当天（测试活动日期 2099-12-31）
    expect(new Date(again.body.expiresAt).getTime()).toBeGreaterThan(new Date('2099-12-31T00:00:00+08:00').getTime());
    expect((await ex()).statusCode).toBe(200);

    // 接口保留的「作废」：二维码不能再用（含已扫过的）
    await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/revoke`, { cookie: ctx.adminCookie, body: {} });
    const after = await ex();
    expect(after.statusCode).toBe(401);
    expect(JSON.parse(after.body).error.details).toMatchObject({ unitName: '浦东', reason: 'REVOKED' });
  });

  it('缺少客户端请求头的写请求被拒绝', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/admin/login', payload: { username: 'admin', password: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('A18 理财未锁定时开启基金', () => {
  it('基金首轮可以会前冻结；但理财锁定后才能开始基金，锁定理财后当前专场自动转到基金', async () => {
    const { eventId } = await liveEvent();
    // liveEvent 已一起冻结理财与基金首轮
    expect((await getState(ctx, eventId)).projects.fund.status).toBe('ROUND1_PUBLISHED');
    expect((await control(ctx, eventId, 'fund', 'START', { groupNo: 1 })).body.error.code).toBe('PROJECT_ORDER');
    for (const g of [1, 2, 3]) {
      if (g > 1) await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: g });
      await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: g });
    }
    // 结束最后一组自动暂停
    expect((await getState(ctx, eventId)).projects.wealth.status).toBe('PAUSED');
    // 三组都已结束：正常锁定，不需要提前收场
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).status).toBe(200);
    expect((await getState(ctx, eventId)).event.currentProject).toBe('fund');
    const st = await control(ctx, eventId, 'fund', 'START', { groupNo: 1 });
    expect(st.status).toBe(200);
    // 理财首轮快照不受基金影响
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.snapshot).not.toBeNull();
    expect(fr.body.projects.fund.draftRows[0].baseTargetWan).toBe('200.00');
  });

  it('非法状态转换被拒绝：锁定须先暂停；锁定后不可恢复', async () => {
    const { eventId } = await liveEvent();
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK })).body.error.code).toBe('INVALID_STATE');
    expect((await control(ctx, eventId, 'wealth', 'LOCK')).body.error.code).toBe('CONFIRM_REQUIRED');
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    expect((await control(ctx, eventId, 'wealth', 'RESUME')).body.error.code).toBe('PROJECT_LOCKED');
  });

  it('提前收场：有分组未结束时正常锁定被拒绝；单独勾选确认后可锁定，记入审计', async () => {
    const { eventId } = await liveEvent();
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    const pv = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/projects/wealth/lock-preview`, { cookie: ctx.adminCookie });
    expect(pv.body.unfinishedGroups.map((g: any) => [g.groupNo, g.statusText])).toEqual([
      [2, '未开始'],
      [3, '未开始'],
    ]);
    const normal = await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    expect(normal.body.error.code).toBe('GROUPS_NOT_FINISHED');
    expect(normal.body.error.message).toContain('第二组（未开始）、第三组（未开始）');
    // 不需要填写原因：勾选「提前收场」即可
    const ok = await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, earlyLock: true });
    expect(ok.status).toBe(200);
    const a = await ctx.db.query(`SELECT reason, details FROM audit_logs WHERE event_id = $1 AND action = 'PROJECT_LOCKED_EARLY'`, [eventId]);
    expect(a.rows[0].reason).toBe('工作人员确认提前收场');
    expect(a.rows[0].details.unfinishedGroups.map((g: any) => g.groupNo)).toEqual([2, 3]);
  });

  it('控制版本过期被拒绝', async () => {
    const { eventId } = await liveEvent();
    const st = await getState(ctx, eventId);
    const body = { action: 'PAUSE', expectedControlVersion: st.projects.wealth.controlVersion - 1, idempotencyKey: idem() };
    const r = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/control`, { cookie: ctx.adminCookie, body });
    expect(r.body.error.code).toBe('CONTROL_VERSION_CONFLICT');
  });

  it('同时最多一个开放组；重新开放已结束组只需确认，原增幅不变', async () => {
    const { eventId, pd } = await liveEvent();
    expect((await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 2 })).body.error.message).toContain('第1组仍在进行');
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    expect((await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 1 })).status).toBe(200);
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
    const lock = await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
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
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    const st = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
    expect(st.body.projects.wealth.status).toBe('LOCKED');
    const screen = await joinScreen(ctx, eventId);
    const res = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/results`, { cookie: screen });
    expect(res.body.projects.wealth.groups[0].rows[0]).toMatchObject({ unitCode: 'PD', leaderLabel: '现场标王', rank: 1 });
    // 第二组最高 10%：组内领先
    expect(res.body.projects.wealth.groups[1].leaderStatus).toBe('GROUP_LEADER');
  });
});

describe('A23 管理员代录与更正', () => {
  it('代录与领导同等校验，标明代录来源，不需要填写原因', async () => {
    const { eventId } = await liveEvent();
    const proxy = (body: object) =>
      call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/bids`, { cookie: ctx.adminCookie, body });
    // 底标未确认
    expect((await proxy({ targetIncreasePp: 10, expectedBidVersion: 0, idempotencyKey: idem() })).body.error.code).toBe('BASE_NOT_ACKNOWLEDGED');
    // 代记底标确认：只需确认，不需要原因
    const ackOk = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/base-ack`, {
      cookie: ctx.adminCookie,
      body: { idempotencyKey: idem() },
    });
    expect(ackOk.body.source).toBe('ADMIN_PROXY');
    // 代录接口仍不能下调
    expect((await proxy({ targetIncreasePp: 5, expectedBidVersion: 0, idempotencyKey: idem() })).body.error.code).toBe('NOT_GREATER');
    const ok = await proxy({ targetIncreasePp: 15, expectedBidVersion: 0, idempotencyKey: idem() });
    expect(ok.status).toBe(201);
    expect(ok.body.receipt).toMatchObject({ source: 'ADMIN_PROXY', fromPp: 10, toPp: 15, deltaPp: 5 });
    const rec = await ctx.db.query(`SELECT source, actor_type FROM bid_records WHERE event_id = $1 AND unit_code = 'MH'`, [eventId]);
    expect(rec.rows[0]).toMatchObject({ source: 'ADMIN_PROXY', actor_type: 'ADMIN' });
    // 数据库层兜底：直接 UPDATE 下调被拒绝
    await expect(
      ctx.db.query(`UPDATE bid_states SET current_pp = 5 WHERE event_id = $1 AND project_code = 'wealth' AND unit_code = 'MH'`, [eventId]),
    ).rejects.toThrow(/不能下调/);
  });

  it('领导误操作：工作人员可下调更正（不低于首轮，锁定前、含本组结束后），大屏与流水同步', async () => {
    const { eventId, pd } = await liveEvent();
    const screen = await joinScreen(ctx, eventId);
    // 领导误把 30% 加到 80%
    expect((await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 80, expectedBidVersion: 0, confirmHighValue: true })).status).toBe(201);
    const correct = (body: object) =>
      call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/PD/correct`, { cookie: ctx.adminCookie, body });
    // 领导自己不能调用更正接口
    const leaderTry = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/PD/correct`, {
      cookie: pd,
      body: { targetIncreasePp: 35, expectedBidVersion: 1, idempotencyKey: idem() },
    });
    expect(leaderTry.status).toBe(401);
    // 不能等于或高于当前、不能低于首轮、不能是小数、版本须最新
    expect((await correct({ targetIncreasePp: 80, expectedBidVersion: 1, idempotencyKey: idem() })).body.error.code).toBe('NOT_LOWER');
    expect((await correct({ targetIncreasePp: 25, expectedBidVersion: 1, idempotencyKey: idem() })).body.error.code).toBe('NOT_LOWER');
    expect((await correct({ targetIncreasePp: 35.5, expectedBidVersion: 1, idempotencyKey: idem() })).body.error.code).toBe('INVALID_VALUE');
    expect((await correct({ targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: idem() })).body.error.code).toBe('VERSION_CONFLICT');
    // 本组已结束、暂停核对时也可以更正
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    const ok = await correct({ targetIncreasePp: 35, expectedBidVersion: 1, idempotencyKey: idem() });
    expect(ok.status).toBe(201);
    expect(ok.body.receipt).toMatchObject({ source: 'ADMIN_CORRECTION', fromPp: 80, toPp: 35, deltaPp: -45, targetWan: '135.00' });
    expect((await pdState(eventId, pd)).currentPp).toBe(35);
    const live = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    expect(live.body.groups[0].rows.find((r: any) => r.unitCode === 'PD')).toMatchObject({ currentPp: 35, targetWan: '135.00' });
    expect(live.body.recentBids[0]).toMatchObject({ unitCode: 'PD', fromPp: 80, toPp: 35, source: 'ADMIN_CORRECTION' });
    const a = await ctx.db.query(`SELECT reason FROM audit_logs WHERE event_id = $1 AND action = 'BID_CORRECTED'`, [eventId]);
    expect(a.rows[0].reason).toContain('更正');
    // 更正后领导仍可在本组重新开放后正常追加
    await control(ctx, eventId, 'wealth', 'OPEN_GROUP', { groupNo: 1 });
    expect((await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 36, expectedBidVersion: 2 })).status).toBe(201);
    // 锁定后不能更正
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    expect((await correct({ targetIncreasePp: 31, expectedBidVersion: 3, idempotencyKey: idem() })).body.error.code).toBe('PROJECT_LOCKED');
    // 导出流水标注更正
    const rec = await ctx.db.query(`SELECT source, from_pp, to_pp, delta_pp FROM bid_records WHERE event_id = $1 AND unit_code = 'PD' ORDER BY event_sequence`, [eventId]);
    expect(rec.rows.map((r: any) => r.source)).toEqual(['LEADER', 'ADMIN_CORRECTION', 'LEADER']);
  });
});
