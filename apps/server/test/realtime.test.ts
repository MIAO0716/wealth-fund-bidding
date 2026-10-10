import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
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
  const done = (async () => {
    const res = await fetch(base + path, {
      headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
      signal: ac.signal,
    });
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
  })();
  return {
    events,
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

    const r = await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 10, expectedBidVersion: 0 });
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
    await bid(ctx, eventId, 'wealth', mh, { targetIncreasePp: 10, expectedBidVersion: 0 });
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 45, expectedBidVersion: 2 });

    const s2 = connect(`/api/v1/screen/events/${eventId}/stream`, screen, lastId);
    await waitFor(() => s2.messages().length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    const replay = s2.messages();
    expect(replay.map((m) => [m.unitCode, m.data.toPp])).toEqual([
      ['PD', 40],
      ['MH', 10],
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

describe('A22 服务重启', () => {
  it('底标、首轮、当前增幅、状态、回执、锁定结果均保留', async () => {
    const { eventId, pd } = await prepared();
    const r = await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0, idempotencyKey: 'restart-key-001' });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
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
