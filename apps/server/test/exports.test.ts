import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeText } from '../src/services/exports';
import {
  type Ctx,
  ack,
  bid,
  call,
  control,
  createFormalEvent,
  fullRows,
  goLive,
  importRows,
  joinUnit,
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

async function download(url: string) {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.adminCookie } });
  return res;
}

async function lockAll(eventId: string, project: 'wealth' | 'fund') {
  for (const g of [1, 2, 3]) {
    const st = (await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie })).body;
    if (st.projects[project].groups.find((x: any) => x.groupNo === g).status === 'WAITING') {
      await control(ctx, eventId, project, 'OPEN_GROUP', { groupNo: g });
    }
    await control(ctx, eventId, project, 'CLOSE_GROUP', { groupNo: g });
  }
  const r = await control(ctx, eventId, project, 'LOCK', { confirm: true });
  expect(r.status).toBe(200);
}

describe('A24 两项目锁定并导出', () => {
  it('32 条最终台账可核对，首轮与流水一致，无凭证泄露', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, [
      ...fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m), base: () => '123.45' }),
      ...fullRows('fund', { base: () => '88.000001' }),
    ]);
    await goLive(ctx, eventId, 'wealth', 1);
    const pd = await joinUnit(ctx, eventId, 'PD');
    await ack(ctx, eventId, 'wealth', pd);
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 35, expectedBidVersion: 0 });
    await bid(ctx, eventId, 'wealth', pd, { targetIncreasePp: 45, expectedBidVersion: 1 });
    // 代录原因包含公式注入字符
    await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/base-ack`, {
      cookie: ctx.adminCookie,
      body: { reason: '口头确认', idempotencyKey: 'ack-mh-000001' },
    });
    await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/units/MH/bids`, {
      cookie: ctx.adminCookie,
      body: { targetIncreasePp: 10, expectedBidVersion: 0, idempotencyKey: 'proxy-mh-00001', reason: '=HYPERLINK("http://x")' },
    });

    // 未锁定时导出：明显标为过程数据
    const mid = await download(`/api/v1/admin/events/${eventId}/exports/ledger.xlsx`);
    expect(mid.statusCode).toBe(200);
    expect(decodeURIComponent(String(mid.headers['content-disposition']))).toContain('过程数据');

    await lockAll(eventId, 'wealth');
    await publish(ctx, eventId, 'fund');
    await control(ctx, eventId, 'fund', 'START');
    await lockAll(eventId, 'fund');

    const res = await download(`/api/v1/admin/events/${eventId}/exports/ledger.xlsx`);
    expect(res.statusCode).toBe(200);
    expect(decodeURIComponent(String(res.headers['content-disposition']))).not.toContain('过程数据');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['首轮结果', '最终竞标台账', '加码流水', '确认与控制记录']);

    const sheetRows = (name: string) => {
      const ws = wb.getWorksheet(name)!;
      const header = (ws.getRow(2).values as unknown[]).slice(1) as string[];
      const out: Record<string, any>[] = [];
      for (let r = 3; r <= ws.rowCount; r++) {
        const vals = (ws.getRow(r).values as unknown[]).slice(1);
        out.push(Object.fromEntries(header.map((h, i) => [h, vals[i]])));
      }
      return { ws, out };
    };

    const first = sheetRows('首轮结果');
    expect(first.out).toHaveLength(32);
    const ledger = sheetRows('最终竞标台账');
    expect(ledger.out).toHaveLength(32);
    expect(String(ledger.ws.getRow(1).getCell(1).value)).toContain('最终公示台账');
    const pdRow = ledger.out.find((r) => r['项目'] === '理财' && r['单位'] === '浦东')!;
    expect(pdRow).toMatchObject({ 首轮增幅: 0.3, 最终增幅: 0.45, '现场累计加码（百分点）': 15, 组内排名: 1, '标王门槛/并列状态': '现场标王', 数据性质: '锁定结果' });
    expect(pdRow['最终目标（万元）']).toBeCloseTo(179.0025, 6);
    // 百分比格式：0.35 显示为 35%，不是 3500%
    const pctCol = 6;
    expect(ledger.ws.getRow(3).getCell(pctCol).numFmt).toBe('0%');

    // 首轮 + 流水累计 = 最终
    const flow = sheetRows('加码流水');
    expect(flow.out).toHaveLength(3);
    for (const r of ledger.out) {
      const added = flow.out
        .filter((f) => f['项目'] === r['项目'] && f['单位'] === r['单位'])
        .reduce((s, f) => s + f['追加（百分点）'], 0);
      expect(Math.round((r['最终增幅'] - r['首轮增幅']) * 100)).toBe(added);
      const fr = first.out.find((f) => f['项目'] === r['项目'] && f['单位'] === r['单位'])!;
      expect(fr['首轮增幅']).toBe(r['首轮增幅']);
    }
    const proxy = flow.out.find((f) => f['来源'] === '工作人员代录')!;
    expect(proxy['代录原因'].startsWith("'=")).toBe(true);

    const controlRows = sheetRows('确认与控制记录').out.map((r) => r['操作']);
    expect(controlRows).toEqual(expect.arrayContaining(['首轮发布', '开始竞标', '项目锁定', '领导确认认领底标', '工作人员代记底标确认']));

    // 不含凭证或会话
    const all = JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
    const secrets = await ctx.db.query('SELECT token_hash FROM sessions UNION ALL SELECT token_hash FROM unit_credentials');
    for (const s of secrets.rows) expect(all).not.toContain(s.token_hash);
    expect(all).not.toMatch(/#t=|#k=|bid_unit|bid_admin/);

    // CSV
    const csv = await download(`/api/v1/admin/events/${eventId}/exports/ledger.csv`);
    expect(csv.statusCode).toBe(200);
    const text = csv.body.replace(/^﻿/, '');
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(34);
    expect(text).toContain('理财,第一组,浦东,123.45,30%,45%,15,179.00,1,现场标王');
    expect((await download(`/api/v1/admin/events/${eventId}/exports/nope.csv`)).statusCode).toBe(404);
  });

  it('公式注入防护', () => {
    expect(safeText('=1+1')).toBe("'=1+1");
    expect(safeText('+86')).toBe("'+86");
    expect(safeText('@x')).toBe("'@x");
    expect(safeText('正常文本')).toBe('正常文本');
  });
});
