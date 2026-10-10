import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Ctx, bid, call, createFormalEvent, fullRows, importRows, joinUnit, setup } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.close();
});

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}：${ms}ms 内未完成`)), ms))]);
}

describe('FIX-01 失败写请求不占满连接池', () => {
  it('超过连接池容量的并发失败报价全部按时返回，之后服务正常', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    const pd = await joinUnit(ctx, eventId, 'PD');
    // 首轮未发布：每个请求都在事务内被拒绝，并写入失败记录与幂等记录
    const results = await within(
      Promise.all(Array.from({ length: 60 }, () => bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 10, expectedBidVersion: 0 }))),
      15_000,
      '并发失败请求',
    );
    expect(results.every((r) => r.body.error?.code === 'PROJECT_NOT_ACTIVE')).toBe(true);
    const failed = await ctx.db.query('SELECT count(*)::int AS n FROM failed_submissions WHERE event_id = $1', [eventId]);
    expect(failed.rows[0].n).toBe(60);
    const h = await within(call(ctx.app, 'GET', '/healthz'), 5_000, '健康检查');
    expect(h.status).toBe(200);
    expect(ctx.db.waitingCount).toBe(0);
    expect(ctx.db.totalCount - ctx.db.idleCount).toBe(0);
  }, 30_000);
});
