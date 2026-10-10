import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsvBuffer, parseXlsxBuffer } from '../src/services/fileparse';
import { templateCsv, templateXlsx } from '../src/services/templates';
import {
  type Ctx,
  call,
  createFormalEvent,
  fullRows,
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

const validate = (eventId: string, rows: object[]) =>
  call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/validate`, {
    cookie: ctx.adminCookie,
    body: { mode: 'upsert', rows },
  });

describe('A01 正式活动未提供底标/首轮', () => {
  it('显示待录入，不能发布或开始，无随机正式数据', async () => {
    const eventId = await createFormalEvent(ctx);
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    const rows = fr.body.projects.wealth.draftRows;
    expect(rows).toHaveLength(16);
    expect(rows.every((r: any) => r.baseTargetWan === null && r.firstRoundPp === null)).toBe(true);
    expect(fr.body.projects.wealth.preview.completeCount).toBe(0);

    const p = await publish(ctx, eventId, 'wealth');
    expect(p.status).toBe(422);
    expect(p.body.error.code).toBe('ROUND1_INCOMPLETE');

    const st = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
    const start = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/projects/wealth/control`, {
      cookie: ctx.adminCookie,
      body: { action: 'START', expectedControlVersion: st.body.projects.wealth.controlVersion, idempotencyKey: idem() },
    });
    expect(start.status).toBe(422);
  });

  it('配置不完整时不能发布', async () => {
    const eventId = await createFormalEvent(ctx, { name: '只填名称' });
    await importRows(ctx, eventId, fullRows('wealth'));
    const p = await publish(ctx, eventId, 'wealth');
    expect(p.body.error.code).toBe('CONFIG_INCOMPLETE');
  });
});

describe('A02 导入第一组5%、第二组10%、第三组15%', () => {
  it('校验通过，首轮和目标正确', async () => {
    const eventId = await createFormalEvent(ctx);
    const v = await validate(eventId, fullRows('wealth'));
    expect(v.status).toBe(200);
    expect(v.body.valid).toBe(true);
    expect(v.body.summary).toMatchObject({ total: 16, ok: 16, errors: 0, creates: 16 });
    const pd = v.body.rows.find((r: any) => r.unitCode === 'PD');
    expect(pd.previewTargetWan).toBe('105.00');
    const xh = v.body.rows.find((r: any) => r.unitCode === 'XH');
    expect(xh.previewTargetWan).toBe('115.00');
    expect(v.body.completenessAfter.wealth).toEqual({ complete: 16, total: 16 });
  });
});

describe('A03 非 5 倍数或低于组别门槛', () => {
  it('分别提示，整批不写入', async () => {
    const eventId = await createFormalEvent(ctx);
    const rows = fullRows('wealth');
    rows[0].firstRoundIncreasePp = 12; // 第一组 12%
    rows.find((r) => r.unitCode === 'HP')!.firstRoundIncreasePp = 5; // 第二组 5%
    rows.find((r) => r.unitCode === 'XH')!.firstRoundIncreasePp = 10; // 第三组 10%
    const v = await validate(eventId, rows);
    expect(v.body.valid).toBe(false);
    expect(v.body.validationId).toBeNull();
    const err = (code: string) => v.body.rows.find((r: any) => r.unitCode === code).errors.join('');
    expect(err('PD')).toContain('不是 5 的整数倍');
    expect(err('HP')).toContain('低于');
    expect(err('XH')).toContain('第三组最低增幅 15%');
    expect(v.body.summary.errors).toBe(3);

    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.preview.completeCount).toBe(0);
  });

  it('0.3、"30%" 等写法给出具体错误，不自动换算', async () => {
    const eventId = await createFormalEvent(ctx);
    const rows = fullRows('wealth').slice(0, 2) as any[];
    rows[0].firstRoundIncreasePp = 0.3;
    rows[1].firstRoundIncreasePp = '30%';
    const v = await validate(eventId, rows);
    expect(v.body.rows[0].errors.join('')).toContain('请填 30');
    expect(v.body.rows[1].errors.join('')).toContain('整数百分点');
  });
});

describe('A04 重复单位、错名称、未知代码、非法底标', () => {
  it('行级报错，无部分成功', async () => {
    const eventId = await createFormalEvent(ctx);
    const rows: any[] = [
      { projectCode: 'wealth', unitCode: 'PD', unitName: '浦东', baseTargetWan: '100', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'PD', unitName: '浦东', baseTargetWan: '200', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'MH', unitName: '宝山', baseTargetWan: '100', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'ZZ', baseTargetWan: '100', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'BS', baseTargetWan: '0', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'JD', baseTargetWan: '1.1234567', firstRoundIncreasePp: 10 },
      { projectCode: 'stock', unitCode: 'FX', baseTargetWan: '100', firstRoundIncreasePp: 10 },
      { projectCode: 'wealth', unitCode: 'SJ', baseTargetWan: '100', firstRoundIncreasePp: 10 },
    ];
    const v = await validate(eventId, rows);
    expect(v.body.valid).toBe(false);
    const e = v.body.rows.map((r: any) => r.errors.join(''));
    expect(e[0]).toContain('重复');
    expect(e[1]).toContain('重复');
    expect(e[2]).toContain('不一致');
    expect(e[3]).toContain('未知单位代码');
    expect(e[4]).toContain('大于 0');
    expect(e[5]).toContain('6 位小数');
    expect(e[6]).toContain('未知项目');
    expect(v.body.rows[7].status).toBe('OK');
    // 有错误的批次不能提交
    const c = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
      cookie: ctx.adminCookie,
      body: { validationId: '00000000-0000-0000-0000-000000000000', expectedDraftVersion: 0, idempotencyKey: idem() },
    });
    expect(c.status).toBe(404);
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.draftRows.find((r: any) => r.unitCode === 'SJ').baseTargetWan).toBeNull();
  });
});

describe('A05 同时导入理财和基金32条', () => {
  it('数据独立；同一单位两项目底标可不同', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, [
      ...fullRows('wealth', { base: () => '100.00' }),
      ...fullRows('fund', { base: () => '250.50' }),
    ]);
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.draftRows[0].baseTargetWan).toBe('100.00');
    expect(fr.body.projects.fund.draftRows[0].baseTargetWan).toBe('250.50');
    expect(fr.body.projects.wealth.preview.completeCount).toBe(16);
    expect(fr.body.projects.fund.preview.completeCount).toBe(16);
  });

  it('upsert 只更新本批记录，漏传不删除', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    await importRows(ctx, eventId, [{ projectCode: 'wealth', unitCode: 'PD', baseTargetWan: '300', firstRoundIncreasePp: 20 }]);
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    const rows = fr.body.projects.wealth.draftRows;
    expect(rows.find((r: any) => r.unitCode === 'PD')).toMatchObject({ baseTargetWan: '300.00', firstRoundPp: 20 });
    expect(rows.find((r: any) => r.unitCode === 'MH')).toMatchObject({ baseTargetWan: '100.00', firstRoundPp: 5 });
  });
});

describe('导入提交的版本与幂等', () => {
  it('校验后草稿被改动，旧 validationId 不能提交', async () => {
    const eventId = await createFormalEvent(ctx);
    const v1 = await validate(eventId, fullRows('wealth'));
    await importRows(ctx, eventId, [{ projectCode: 'wealth', unitCode: 'PD', baseTargetWan: '1', firstRoundIncreasePp: 5 }]);
    const c = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
      cookie: ctx.adminCookie,
      body: { validationId: v1.body.validationId, expectedDraftVersion: v1.body.draftVersion, idempotencyKey: idem() },
    });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('DRAFT_VERSION_CONFLICT');
  });

  it('相同幂等键重复提交不生成重复批次；同键不同内容报冲突', async () => {
    const eventId = await createFormalEvent(ctx);
    const v = await validate(eventId, fullRows('wealth'));
    const key = idem('imp');
    const body = { validationId: v.body.validationId, expectedDraftVersion: v.body.draftVersion, idempotencyKey: key };
    const c1 = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, { cookie: ctx.adminCookie, body });
    const c2 = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, { cookie: ctx.adminCookie, body });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.body.replayed).toBe(true);
    expect(c2.body.batchId).toBe(c1.body.batchId);
    expect(c1.body.draftVersion).toBe(1);
    const c3 = await call(ctx.app, 'POST', `/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
      cookie: ctx.adminCookie,
      body: { ...body, expectedDraftVersion: 99 },
    });
    expect(c3.status).toBe(409);
    expect(c3.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.batches).toHaveLength(1);
  });

  it('手动录入走同一校验', async () => {
    const eventId = await createFormalEvent(ctx);
    const put = (body: object) =>
      call(ctx.app, 'PUT', `/api/v1/admin/events/${eventId}/first-round/drafts/wealth/HP`, { cookie: ctx.adminCookie, body });
    const bad = await put({ baseTargetWan: '100', firstRoundIncreasePp: 5, expectedDraftVersion: 0, idempotencyKey: idem() });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain('低于');
    const ok = await put({ baseTargetWan: '100', firstRoundIncreasePp: 10, expectedDraftVersion: 0, idempotencyKey: idem() });
    expect(ok.status).toBe(200);
    expect(ok.body.source).toBe('MANUAL');
  });
});

describe('A06 草稿导入成功但尚未现场发布', () => {
  it('管理员可预览；大屏不泄露完整榜单；单位只看自己', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m) }));
    const fr = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/first-round`, { cookie: ctx.adminCookie });
    expect(fr.body.projects.wealth.preview.groups[0].rows[0]).toMatchObject({ unitCode: 'PD', firstRoundPp: 30, rank: 1 });

    const screen = await joinScreen(ctx, eventId);
    const sf = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/projects/wealth/first-round`, { cookie: screen });
    expect(sf.status).toBe(200);
    expect(sf.body.board.published).toBe(false);
    expect(sf.body.board.groups.every((g: any) => g.rows.length === 0)).toBe(true);
    expect(JSON.stringify(sf.body)).not.toContain('"firstRoundPp":30');
    const live = await call(ctx.app, 'GET', `/api/v1/screen/events/${eventId}/live`, { cookie: screen });
    expect(live.body.groups).toEqual([]);

    const pd = await joinUnit(ctx, eventId, 'PD');
    const mine = await me(ctx, eventId, pd);
    expect(mine.projects.wealth).toMatchObject({ published: false, firstRoundPp: 30, baseTargetWan: '100.00', currentPp: null });
    expect(JSON.stringify(mine)).not.toContain('MH');
  });

  it('发布后不可覆盖', async () => {
    const eventId = await createFormalEvent(ctx);
    await importRows(ctx, eventId, fullRows('wealth'));
    expect((await publish(ctx, eventId, 'wealth')).status).toBe(200);
    const v = await validate(eventId, [{ projectCode: 'wealth', unitCode: 'PD', baseTargetWan: '1', firstRoundIncreasePp: 50 }]);
    expect(v.body.valid).toBe(false);
    expect(v.body.rows[0].errors.join('')).toContain('已发布');
  });
});

describe('模板与文件解析', () => {
  it('空白模板 32 行，无演示数值', async () => {
    const csv = templateCsv().toString('utf8');
    const lines = csv.replace(/^﻿/, '').trim().split(/\r\n/);
    expect(lines).toHaveLength(33);
    expect(lines[1]).toBe('理财,PD,浦东,,,');
    const parsed = parseCsvBuffer(templateCsv());
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.skippedBlank).toBe(32);
    const xlsx = await parseXlsxBuffer(await templateXlsx());
    expect(xlsx.rows).toHaveLength(0);
    expect(xlsx.skippedBlank).toBe(32);
  });

  it('Excel 填写后解析为待校验行；百分比格式 0.3 原样传给校验', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await templateXlsx()) as any);
    const ws = wb.getWorksheet('首轮数据')!;
    ws.getRow(2).getCell(4).value = 123.45;
    ws.getRow(2).getCell(5).value = 30;
    ws.getRow(3).getCell(4).value = 100;
    ws.getRow(3).getCell(5).value = 0.3;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ projectCode: '理财', unitCode: 'PD', baseTargetWan: '123.45', firstRoundIncreasePp: 30, sourceRow: 2 });
    expect(parsed.rows[1].firstRoundIncreasePp).toBe(0.3);
  });

  it('GBK 编码的 CSV 可识别', async () => {
    const iconv = (await import('iconv-lite')).default;
    const text = '项目,单位代码,单位名称,基础底标（万元）,首轮增幅（百分点）,备注\r\n理财,PD,浦东,100,30,首轮\r\n';
    const parsed = parseCsvBuffer(iconv.encode(text, 'gbk'));
    expect(parsed.rows[0]).toMatchObject({ projectCode: '理财', unitCode: 'PD', unitName: '浦东', baseTargetWan: '100', firstRoundIncreasePp: 30, remark: '首轮' });
  });

  it('通过上传接口校验', async () => {
    const eventId = await createFormalEvent(ctx);
    const csv = '﻿项目,单位代码,单位名称,基础底标（万元）,首轮增幅（百分点）,备注\r\n理财,PD,浦东,100,12,\r\n';
    const boundary = '----t' + Date.now();
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r1.csv"\r\nContent-Type: text/csv\r\n\r\n` +
      csv +
      `\r\n--${boundary}--\r\n`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${eventId}/first-round/imports/upload`,
      headers: { 'x-bidding-client': '1', cookie: ctx.adminCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(payload, 'utf8'),
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.rows[0].sourceRow).toBe(2);
    expect(body.rows[0].errors.join('')).toContain('5 的整数倍');
  });
});
