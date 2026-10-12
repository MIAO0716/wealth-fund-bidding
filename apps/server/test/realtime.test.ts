import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAdmin } from '../src/services/auth';
import { EARLY_LOCK,
  type Ctx,
  ack,
  bid,
  call,
  cookieFrom,
  control,
  createFormalEvent,
  fullRows,
  getState,
  goLive,
  importRows,
  joinScreen,
  joinUnit,
  me,
  setup,
  testConfig,
} from './helpers';

let ctx: Ctx;
let base: string;

beforeAll(async () => {
  ctx = await setup();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = ctx.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await ctx.close();
});

interface SseEvent {
  event: string;
  id?: string;
  data: any;
  at: number;
}

/** 极简 SSE 客户端：真实 HTTP 长连接 */
function connect(path: string, cookie: string, lastEventId?: string) {
  const events: SseEvent[] = [];
  const ac = new AbortController();
  let ended = false;
  let status = 0;
  const done = (async () => {
    const res = await fetch(base + path, {
      headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
      signal: ac.signal,
    });
    status = res.status;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev: Partial<SseEvent> = { event: 'message', at: Date.now() };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.data !== undefined) events.push(ev as SseEvent);
        }
      }
    } catch {
      // 主动断开
    }
    ended = true;
  })();
  return {
    events,
    /** 服务端已结束该连接 */
    ended: () => ended,
    status: () => status,
    messages: () => events.filter((e) => e.event === 'message').map((e) => e.data),
    close: async () => {
      ac.abort();
      await done.catch(() => {});
    },
  };
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function prepared() {
  const eventId = await createFormalEvent(ctx);
  await importRows(ctx, eventId, fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m) }));
  await goLive(ctx, eventId, 'wealth', 1);
  const pd = await joinUnit(ctx, eventId, 'PD');
  const mh = await joinUnit(ctx, eventId, 'MH');
  await ack(ctx, eventId, 'wealth', pd);
  await ack(ctx, eventId, 'wealth', mh);
  const screen = await joinScreen(ctx, eventId);
  return { eventId, pd, mh, screen };
}

describe('实时推送', () => {
  it('提交成功后大屏 1 秒内收到；领导只收到本单位与项目级消息', async () => {
    const { eventId, pd, mh, screen } = await prepared();
    const snap = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    const s = connect(`/api/v1/screen/events/${eventId}/stream?since=${snap.body.seq}`, screen);
    const pdMe = await me(ctx, eventId, pd);
    const p = connect(`/api/v1/bidder/events/${eventId}/stream?since=${pdMe.seq}`, pd);
    await waitFor(() => s.events.some((e) => e.event === 'hello') && p.events.some((e) => e.event === 'hello'));

    const r = await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 15, expectedBidVersion: 0 });
    const t0 = Date.now();
    await waitFor(() => s.messages().some((m) => m.type === 'BID_ACCEPTED'));
    const latency = s.events.find((e) => e.data?.type === 'BID_ACCEPTED')!.at - t0;
    expect(latency).toBeLessThan(1000);
    expect(s.messages()[0]).toMatchObject({ type: 'BID_ACCEPTED', unitCode: 'MH', seq: r.body.receipt.eventSequence });

    // 浦东的连接不应收到闵行的报价
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await waitFor(() => p.messages().some((m) => m.type === 'BID_ACCEPTED'));
    expect(p.messages().filter((m) => m.type === 'BID_ACCEPTED').map((m) => m.unitCode)).toEqual(['PD']);

    // 项目级消息双方都收到
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await waitFor(() => p.messages().some((m) => m.type === 'PROJECT_STATUS'));
    await waitFor(() => s.messages().some((m) => m.type === 'PROJECT_STATUS'));
    await s.close();
    await p.close();
  });

  it('A21 大屏断线后重连：按序补发，不漏、不重复；首轮值不变', async () => {
    const { eventId, pd, mh, screen } = await prepared();
    const snap = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    const s1 = connect(`/api/v1/screen/events/${eventId}/stream?since=${snap.body.seq}`, screen);
    await waitFor(() => s1.events.some((e) => e.event === 'hello'));
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await waitFor(() => s1.messages().length === 1);
    const lastId = s1.events.filter((e) => e.id).at(-1)!.id!;
    await s1.close();

    // 断线期间发生 3 次加码
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 40, expectedBidVersion: 1 });
    await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 15, expectedBidVersion: 0 });
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 45, expectedBidVersion: 2 });

    const s2 = connect(`/api/v1/screen/events/${eventId}/stream`, screen, lastId);
    await waitFor(() => s2.messages().length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    const replay = s2.messages();
    expect(replay.map((m) => [m.unitCode, m.data.toPp])).toEqual([
      ['PD', 40],
      ['MH', 15],
      ['PD', 45],
    ]);
    const seqs = replay.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    await s2.close();

    const live = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    expect(live.body.groups[0].rows.find((r: any) => r.unitCode === 'PD')).toMatchObject({ firstRoundPp: 30, currentPp: 45 });
  });

  it('客户端序列超前于服务端时要求重新同步', async () => {
    const { eventId, screen } = await prepared();
    const s = connect(`/api/v1/screen/events/${eventId}/stream?since=999999`, screen);
    await waitFor(() => s.events.some((e) => e.event === 'resync'));
    await s.close();
  });

  it('大屏收不到草稿变更等管理端消息', async () => {
    const eventId = await createFormalEvent(ctx);
    const screen = await joinScreen(ctx, eventId);
    const s = connect(`/api/v1/screen/events/${eventId}/stream?since=0`, screen);
    await waitFor(() => s.events.some((e) => e.event === 'hello'));
    await importRows(ctx, eventId, fullRows('wealth'));
    await new Promise((r) => setTimeout(r, 300));
    expect(s.messages().filter((m) => m.type === 'DRAFT_UPDATED')).toHaveLength(0);
    await s.close();
  });
});

describe('FIX-04 实时连接随访问权限失效', () => {
  const pdStream = async (eventId: string, cookie: string) => {
    const c = connect(`/api/v1/bidder/events/${eventId}/stream?since=${(await me(ctx, eventId, cookie)).seq}`, cookie);
    await waitFor(() => c.events.some((e) => e.event === 'hello'));
    return c;
  };

  it('领导换手机：旧手机连接收到 revoked 并关闭，之后的报价不再推送；旧会话无法重连', async () => {
    const { eventId, pd } = await prepared();
    const old = await pdStream(eventId, pd);
    const pdNew = await joinUnit(ctx, eventId, 'PD');
    await waitFor(() => old.ended(), 5000);
    expect(old.events.some((e) => e.event === 'revoked')).toBe(true);
    await ack(ctx, eventId, 'wealth', pdNew);
    const r = await bid(ctx, eventId, 'wealth', pdNew, { targetIncreasePp: 35, expectedBidVersion: 0 });
    expect(r.status).toBe(201);
    expect(old.messages().filter((m) => m.type === 'BID_ACCEPTED')).toHaveLength(0);
    const again = connect(`/api/v1/bidder/events/${eventId}/stream?since=0`, pd);
    await waitFor(() => again.ended());
    expect(again.status()).toBe(401);
    // 新手机正常
    const fresh = await pdStream(eventId, pdNew);
    await fresh.close();
  });

  it('撤销提交后的事件一律不推给旧连接（同一快照判定）', async () => {
    const { eventId, pd, mh } = await prepared();
    const old = await pdStream(eventId, pd);
    // 撤销与随后的报价背靠背提交
    await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/units/PD/revoke`, { cookie: ctx.adminCookie, body: { reason: '测试' } });
    await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 15, expectedBidVersion: 0 });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await waitFor(() => old.ended(), 5000);
    expect(old.messages().filter((m) => m.type === 'PROJECT_STATUS' || m.type === 'BID_ACCEPTED')).toHaveLength(0);
  });

  it('大屏凭证撤销后连接关闭；其他大屏不受影响', async () => {
    const { eventId, screen } = await prepared();
    const other = await joinScreen(ctx, eventId);
    const s1 = connect(`/api/v1/screen/events/${eventId}/stream?since=0`, screen);
    const s2 = connect(`/api/v1/screen/events/${eventId}/stream?since=0`, other);
    await waitFor(() => s1.events.some((e) => e.event === 'hello') && s2.events.some((e) => e.event === 'hello'));
    const keys = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/screen-keys`, { cookie: ctx.adminCookie });
    const first = keys.body.keys[0];
    await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/screen-keys/${first.id}/revoke`, { cookie: ctx.adminCookie, body: {} });
    await waitFor(() => s1.ended(), 5000);
    expect(s2.ended()).toBe(false);
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await waitFor(() => s2.messages().some((m) => m.type === 'PROJECT_STATUS'));
    await s2.close();
  });

  it('会话到期后约 3 秒内停止推送并关闭', async () => {
    const { eventId, pd } = await prepared();
    const old = await pdStream(eventId, pd);
    await ctx.db.query(`UPDATE sessions SET expires_at = now() WHERE role = 'BIDDER' AND event_id = $1 AND unit_code = 'PD'`, [eventId]);
    await waitFor(() => old.ended(), 5000);
    expect(old.events.some((e) => e.event === 'revoked')).toBe(true);
  });

  it('FIX-03 重置管理员密码：该管理员的旧连接与旧 Cookie 失效，其他管理员不受影响', async () => {
    const eventId = await createFormalEvent(ctx);
    await createAdmin(ctx.db, 'admin2', '第二管理员', 'admin2-password-1');
    const login = (password: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/auth/admin/login', headers: { 'x-bidding-client': '1' }, payload: { username: 'admin2', password } });
    const l1 = await login('admin2-password-1');
    expect(l1.statusCode).toBe(200);
    const a2 = cookieFrom(l1.headers['set-cookie']);
    const s2 = connect(`/api/v1/admin/events/${eventId}/stream?since=0`, a2);
    const s1 = connect(`/api/v1/admin/events/${eventId}/stream?since=0`, ctx.adminCookie);
    await waitFor(() => s1.events.some((e) => e.event === 'hello') && s2.events.some((e) => e.event === 'hello'));

    await createAdmin(ctx.db, 'admin2', '第二管理员', 'admin2-password-2');
    await waitFor(() => s2.ended(), 5000);
    expect((await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: a2 })).status).toBe(401);
    expect((await login('admin2-password-1')).statusCode).toBe(401);
    expect((await login('admin2-password-2')).statusCode).toBe(200);
    // 其他管理员的会话与连接照常
    expect((await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie })).status).toBe(200);
    expect(s1.ended()).toBe(false);
    await s1.close();
  });
});

describe('A22 服务重启', () => {
  it('底标、首轮、当前增幅、状态、回执、锁定结果均保留', async () => {
    const { eventId, pd } = await prepared();
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: 'restart-key-001' });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true, ...EARLY_LOCK });
    const before = await getState(ctx, eventId);

    // 新进程（同一数据库，不重置）
    const second = await buildApp(testConfig(), { logger: false });
    try {
      const after = (await call(second.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie })).body;
      expect(after.projects.wealth.status).toBe('LOCKED');
      expect(after.boards).toEqual(before.boards);
      const q = await call(second.app, 'GET', `/api/v1/bidder/events/${eventId}/requests/restart-key-001`, { cookie: pd });
      expect(q.body.response.receiptNo).toBe(r.body.receipt.receiptNo);
      const mine = (await call(second.app, 'GET', `/api/v1/bidder/events/${eventId}/me`, { cookie: pd })).body;
      expect(mine.projects.wealth).toMatchObject({ baseTargetWan: '100.00', firstRoundPp: 30, currentPp: 35, baseAcknowledged: true, status: 'LOCKED' });
    } finally {
      await second.app.close();
      await second.db.end().catch(() => {});
    }
  });
});
