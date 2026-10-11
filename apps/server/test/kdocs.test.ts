import { KDOCS_LAYOUT, UNITS } from '@bidding/shared';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KdocsError, callScript, normalizeWebhookUrl } from '../src/services/kdocs/client';
import { MockWorkbook, runAirScript } from '../src/services/kdocs/mock';
import { type Ctx, FULL_CONFIG as FULL, call, control, createFormalEvent, fullRows, goLive, importRows, publish, setup } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  await ctx.kdocs.sync.start();
});
afterAll(async () => {
  await ctx.close();
});

const api = (eventId: string, path = '') => `/api/v1/admin/events/${eventId}/kdocs${path}`;
const mock = () => ctx.kdocs.mock!;

/** 新活动（浦东首轮 30%），绑定模拟金山文档并开启同步（间隔 60 秒，测试中手动触发） */
async function prepared(opts: { live?: boolean; enable?: boolean } = {}) {
  mock().failNext = 0;
  const eventId = await createFormalEvent(ctx);
  await importRows(ctx, eventId, [...fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m) }), ...fullRows('fund', { base: () => '200' })]);
  const m = await call(ctx.app, 'POST', api(eventId, '/use-mock'), { cookie: ctx.adminCookie, body: {} });
  expect(m.status).toBe(200);
  const fileId: string = m.body.mockFileId;
  if (opts.enable !== false) await enable(eventId);
  if (opts.live) await goLive(ctx, eventId, 'wealth', 1);
  return { eventId, fileId };
}

async function enable(eventId: string, enabled = true) {
  const r = await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled, intervalSec: 60 } });
  expect(r.status).toBe(200);
  if (enabled) await syncNow(eventId);
}

async function syncNow(eventId: string) {
  const r = await call(ctx.app, 'POST', api(eventId, '/sync-now'), { cookie: ctx.adminCookie, body: {} });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
}

const cell = (fileId: string, sheet: string, addr: string) => mock().file(fileId)!.sheet(sheet)!.read(addr)[0][0];
const edit = (fileId: string, sheet: string, addr: string, value: unknown) => mock().editCell(fileId, sheet, addr, value);

/** 领导确认认领底标（发布后程序先清空 B11 并提示，之后选「确认」才有效） */
async function ackViaDoc(eventId: string, fileId: string, unitName: string) {
  await syncNow(eventId);
  expect(String(cell(fileId, unitName, 'C11'))).toContain('请在 B11 选择「确认」');
  edit(fileId, unitName, 'B11', '确认');
  await syncNow(eventId);
  expect(String(cell(fileId, unitName, 'C11'))).toContain('已确认（理财');
}

describe('AirScript 与接口', () => {
  it('脚本在模拟工作簿中运行：先写后读，缺失工作表如实报告，协议版本不符时拒绝', () => {
    const wb = new MockWorkbook('t');
    wb.addSheet('浦东');
    const r = runAirScript(wb, {
      protocol: 1,
      action: 'batch',
      writes: [
        { sheet: '浦东', range: 'B13:C13', values: [['35', '确认']] },
        { sheet: '浦东', range: 'B11', values: [['确认']] },
        { sheet: '闵行', range: 'A1', values: [['x']] },
      ],
      reads: [
        { sheet: '浦东', range: 'B11:C13' },
        { sheet: '闵行', range: 'B11:C13' },
      ],
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.written).toBe(2);
    expect(r.missingSheets).toEqual(['闵行']);
    expect(r.reads[0].values).toEqual([
      ['确认', null],
      [null, null],
      ['35', '确认'],
    ]);
    expect(r.reads[1].values).toBeNull();
    expect((runAirScript(wb, { protocol: 99 }) as any).ok).toBe(false);
  });

  it('webhook 链接只接受金山文档与本机模拟地址', () => {
    expect(normalizeWebhookUrl('https://www.kdocs.cn/api/v3/ide/file/abc123/script/V2-xyz/sync_task')).toBe(
      'https://www.kdocs.cn/api/v3/ide/file/abc123/script/V2-xyz/sync_task',
    );
    expect(() => normalizeWebhookUrl('https://evil.example.com/api/v3/ide/file/a/script/b/sync_task')).toThrow();
    expect(() => normalizeWebhookUrl('http://www.kdocs.cn/api/v3/ide/file/a/script/b/sync_task')).toThrow();
    expect(() => normalizeWebhookUrl('https://www.kdocs.cn/l/abcdef')).toThrow();
    expect(normalizeWebhookUrl('http://127.0.0.1:8080/mock-kdocs/api/v3/ide/file/m1/script/s1/sync_task')).toContain('/mock-kdocs/');
    expect(() => normalizeWebhookUrl('http://10.0.0.5:8080/mock-kdocs/api/v3/ide/file/m1/script/s1/sync_task')).toThrow();
  });

  it('解析金山返回：result 为对象或 JSON 字符串；脚本错误、令牌错误、无返回值均给出说明', async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const ok = { protocol: 1, ok: true, sheets: ['浦东'] };
    const url = 'https://www.kdocs.cn/api/v3/ide/file/f/script/s/sync_task';
    expect((await callScript(url, 't', { action: 'ping' }, { fetchImpl: respond(200, { status: 'finished', error: '', data: { result: ok } }) })).sheets).toEqual(['浦东']);
    expect((await callScript(url, 't', { action: 'ping' }, { fetchImpl: respond(200, { status: 'finished', error: '', data: { result: JSON.stringify(ok) } }) })).ok).toBe(true);
    const err = async (status: number, body: unknown) => {
      try {
        await callScript(url, 't', { action: 'ping' }, { fetchImpl: respond(status, body) });
      } catch (e) {
        return e as KdocsError;
      }
      throw new Error('应当失败');
    };
    expect((await err(200, { status: 'finished', error: 'ReferenceError: x', data: {} })).kind).toBe('SCRIPT');
    expect((await err(401, { error: 'bad token' })).kind).toBe('AUTH');
    expect((await err(200, { status: 'finished', error: '', data: { result: null } })).message).toContain('return main(Context.argv)');
    expect((await err(200, { status: 'finished', error: '', data: { result: { protocol: 2 } } })).message).toContain('重新下载脚本');
    expect((await err(429, {})).message).toContain('限流');
  });
});

describe('配置与表格初始化', () => {
  it('使用模拟金山文档：写好 16 张表的版式；测试连接列出工作表；令牌不回显', async () => {
    const { eventId, fileId } = await prepared({ enable: false });
    expect(cell(fileId, '浦东', 'A12')).toBe('序号');
    expect(cell(fileId, '浦东', 'B12')).toBe('加到（%）');
    expect(cell(fileId, '崇明', `A${KDOCS_LAYOUT.firstBidRow}`)).toBe(1);
    const t = await call(ctx.app, 'POST', api(eventId, '/test'), { cookie: ctx.adminCookie, body: {} });
    expect(t.body.ok).toBe(true);
    expect(t.body.missingUnits).toEqual([]);
    const o = await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie });
    expect(o.body.binding.tokenMasked).toMatch(/^\*\*\*\*/);
    expect(JSON.stringify(o.body)).not.toContain(mock().token);
    expect(o.body.binding.isMock).toBe(true);
  });

  it('同步开启时不能清空填写区；模板包含说明表与 16 张单位表', async () => {
    const { eventId } = await prepared();
    const r = await call(ctx.app, 'POST', api(eventId, '/init-layout'), { cookie: ctx.adminCookie, body: { clearInputs: true } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('先停止同步');
    const res = await ctx.app.inject({ method: 'GET', url: api(eventId, '/template.xlsx'), headers: { cookie: ctx.adminCookie } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['使用说明', ...UNITS.map((u) => u.name)]);
    expect(wb.getWorksheet('浦东')!.getCell('C13').dataValidation?.formulae).toEqual(['"确认"']);
    const script = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/kdocs/airscript.js', headers: { cookie: ctx.adminCookie } });
    expect(script.body).toContain('return main(Context.argv);');
  });
});

describe('通过金山文档竞标', () => {
  it('认领底标 → 加码生效；重复、填错、未确认、改已处理的行、非本组均不会多记；信息区与大屏同步', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ackViaDoc(eventId, fileId, '浦东');

    // 加到 35%
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'D13'))).toMatch(/^✔ 已生效：30% → 35%（回执 LC-PD-001-\d+）$/);
    expect(cell(fileId, '浦东', 'E13')).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(cell(fileId, '浦东', 'B8')).toBe('35%');
    expect(cell(fileId, '浦东', 'B10')).toBe('40 / 45 / 50 / 55');
    const rec = await ctx.db.query(`SELECT source, actor_type, to_pp FROM bid_records WHERE event_id = $1`, [eventId]);
    expect(rec.rows).toEqual([{ source: 'KDOCS', actor_type: 'LEADER', to_pp: 35 }]);

    // 重复填 35：不重复加码
    edit(fileId, '浦东', 'B14', 35);
    edit(fileId, '浦东', 'C14', '确认');
    // 无法识别的数值
    edit(fileId, '浦东', 'B15', '四十');
    edit(fileId, '浦东', 'C15', '确认');
    // 填了未确认
    edit(fileId, '浦东', 'B16', '40%');
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'D14'))).toContain('✘ 未生效：新增幅 35% 必须高于已确认增幅 35%');
    expect(String(cell(fileId, '浦东', 'D15'))).toContain('无法识别');
    expect(cell(fileId, '浦东', 'D16')).toBe('待确认：请在 C 列选择「确认」后生效');

    // 确认后生效；之后改已处理的行无效
    edit(fileId, '浦东', 'C16', '是');
    edit(fileId, '浦东', 'B13', '60');
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'D16'))).toContain('已生效：35% → 40%');
    expect(String(cell(fileId, '浦东', 'D13'))).toContain('此行已处理，之后的修改无效');
    const n = await ctx.db.query(`SELECT count(*)::int AS n, max(to_pp) AS top FROM bid_records WHERE event_id = $1`, [eventId]);
    expect(n.rows[0]).toEqual({ n: 2, top: 40 });

    // 第二组（黄浦）尚未开放
    edit(fileId, '黄浦', 'B13', '20');
    edit(fileId, '黄浦', 'C13', '确认');
    await syncNow(eventId);
    expect(String(cell(fileId, '黄浦', 'D13'))).toMatch(/✘ 未生效：(尚未轮到本组|请先确认认领基础底标)/);
    expect(cell(fileId, '黄浦', 'B5')).toBe('竞标中，尚未轮到本组');

    // 大屏同步
    const screen = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
    const pd = screen.body.boards.wealth.flatMap((g: any) => g.rows).find((r: any) => r.unitCode === 'PD');
    expect(pd.currentPp).toBe(40);
  });

  it('首次开启同步前已填写的行不参与竞标（便于反复演练）', async () => {
    const { eventId, fileId } = await prepared({ enable: false, live: true });
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    await enable(eventId);
    await syncNow(eventId);
    expect(cell(fileId, '浦东', 'D13')).toBe('— 开始同步前已填写，未处理');
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(0);
    // 暂停同步期间填写的行，恢复后照常处理（不会被当作同步前已填写）
    await ackViaDoc(eventId, fileId, '浦东');
    await enable(eventId, false);
    edit(fileId, '浦东', 'B14', '35');
    edit(fileId, '浦东', 'C14', '确认');
    await enable(eventId, true);
    expect(String(cell(fileId, '浦东', 'D14'))).toContain('已生效：30% → 35%');
  });

  it('结束本组前先读取一次：最后一刻的填写仍按开放状态处理', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ackViaDoc(eventId, fileId, '浦东');
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    // 不手动同步，直接结束本组
    const r = await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    expect(r.status).toBe(200);
    expect(r.body.kdocsWarning).toBeUndefined();
    const b = await ctx.db.query('SELECT to_pp FROM bid_records WHERE event_id = $1', [eventId]);
    expect(b.rows).toEqual([{ to_pp: 35 }]);
  });

  it('程序中断后重复处理同一行：不会重复加码，回执相同', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ackViaDoc(eventId, fileId, '浦东');
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    await syncNow(eventId);
    const before = String(cell(fileId, '浦东', 'D13'));
    // 模拟「已加码但处理记录未写入」：删除处理记录并重启同步
    await ctx.db.query('DELETE FROM kdocs_rows WHERE event_id = $1', [eventId]);
    await enable(eventId, false);
    await enable(eventId, true);
    await syncNow(eventId);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(1);
    expect(String(cell(fileId, '浦东', 'D13'))).toBe(before);
  });

  it('换专场：上一专场的「确认」不会用于认领下一专场底标', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ackViaDoc(eventId, fileId, '浦东');
    for (const g of [1]) await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: g });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).status).toBe(200);
    expect((await publish(ctx, eventId, 'fund')).status).toBe(200);
    expect(cell(fileId, '浦东', 'B11')).toBe('确认');
    await syncNow(eventId);
    expect(cell(fileId, '浦东', 'B11')).toBeNull();
    expect(String(cell(fileId, '浦东', 'C11'))).toContain('认领基金底标');
    const ack = await ctx.db.query(`SELECT base_ack_at FROM bid_states WHERE event_id = $1 AND project_code = 'fund' AND unit_code = 'PD'`, [eventId]);
    expect(ack.rows[0].base_ack_at).toBeNull();
    edit(fileId, '浦东', 'B11', '确认');
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'C11'))).toContain('已确认（基金');
    const src = await ctx.db.query(`SELECT base_ack_source FROM bid_states WHERE event_id = $1 AND project_code = 'fund' AND unit_code = 'PD'`, [eventId]);
    expect(src.rows[0].base_ack_source).toBe('KDOCS');
  });

  it('金山文档不可用：显示错误、不阻塞现场操作，恢复后自动继续', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ackViaDoc(eventId, fileId, '浦东');
    mock().failNext = 100;
    const r = await call(ctx.app, 'POST', api(eventId, '/sync-now'), { cookie: ctx.adminCookie, body: {} });
    expect(r.status).toBe(422);
    const o = await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie });
    expect(o.body.status.state).toBe('ERROR');
    expect(o.body.status.lastError).toContain('暂不可用');
    // 暂停仍可执行，并提示最后几秒可能未读入
    const p = await control(ctx, eventId, 'wealth', 'PAUSE');
    expect(p.status).toBe(200);
    expect(p.body.kdocsWarning).toContain('读取金山文档失败');
    mock().failNext = 0;
    await control(ctx, eventId, 'wealth', 'RESUME');
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'D13'))).toContain('已生效');
    const o2 = await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie });
    expect(o2.body.status.state).toBe('RUNNING');
    expect(o2.body.counts.APPLIED).toBe(1);
  });

  it('后台定时同步（不手动触发）：看到「请确认」提示后选择「确认」，不会被程序清掉', async () => {
    const { eventId, fileId } = await prepared({ enable: false, live: true });
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: true, intervalSec: 1 } });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 200));
      return cond();
    };
    expect(await waitFor(() => String(cell(fileId, '浦东', 'C11')).includes('请在 B11'))).toBe(true);
    edit(fileId, '浦东', 'B11', '确认');
    expect(await waitFor(() => String(cell(fileId, '浦东', 'C11')).includes('已确认'))).toBe(true);
    edit(fileId, '浦东', 'B13', '35');
    edit(fileId, '浦东', 'C13', '确认');
    expect(await waitFor(() => String(cell(fileId, '浦东', 'D13')).includes('已生效'))).toBe(true);
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: false } });
  }, 30_000);

  it('令牌错误时提示原因', async () => {
    const { eventId } = await prepared({ enable: false });
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { token: 'wrong-token-xxxx' } });
    const t = await call(ctx.app, 'POST', api(eventId, '/test'), { cookie: ctx.adminCookie, body: {} });
    expect(t.status).toBe(422);
    expect(t.body.error.message).toContain('AirScript-Token 无效');
  });
});

describe('一键连接', () => {
  const connect = (eventId: string, body: object) => call(ctx.app, 'POST', api(eventId, '/connect'), { cookie: ctx.adminCookie, body });

  it('粘贴链接和令牌一键完成：保存 → 测试连接 → 写入版式 → 开启同步', async () => {
    const { eventId: a, fileId } = await prepared({ enable: false });
    const url = (await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie })).body.binding.webhookUrl;
    // 新活动直接粘贴同一个链接和令牌
    const b = await createFormalEvent(ctx, { ...FULL, name: '一键连接测试' });
    const r = await connect(b, { webhookUrl: url, token: mock().token });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.steps.map((x: any) => [x.name, x.ok])).toEqual([
      ['保存链接与令牌', true],
      ['测试连接', true],
      ['写入表格版式', true],
      ['开启同步', true],
    ]);
    expect(r.body.overview.binding.enabled).toBe(true);
    expect(cell(fileId, '浦东', 'A1')).toBe('浦东 · 一键连接测试');
  });

  it('同一张表格改由新活动同步时，旧活动的同步自动停止', async () => {
    const { eventId: a } = await prepared();
    const url = (await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie })).body.binding.webhookUrl;
    const b = await createFormalEvent(ctx, { ...FULL, name: '新活动' });
    const r = await connect(b, { webhookUrl: url, token: mock().token });
    expect(r.body.steps.at(-1).detail).toContain('同步已自动停止');
    const oa = await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie });
    expect(oa.body.binding.enabled).toBe(false);
    expect(ctx.kdocs.sync.isActive(a)).toBe(false);
    expect(ctx.kdocs.sync.isActive(b)).toBe(true);
    await call(ctx.app, 'PUT', api(b), { cookie: ctx.adminCookie, body: { enabled: false } });
  });

  it('逐项报告失败原因：令牌错误、缺少工作表', async () => {
    const { eventId, fileId } = await prepared({ enable: false });
    const bad = await connect(eventId, { token: 'wrong-token-1234' });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.steps.map((x: any) => x.ok)).toEqual([true, false]);
    expect(bad.body.steps[1].detail).toContain('AirScript-Token 无效');
    const wb = mock().file(fileId)!;
    wb.sheets.splice(wb.sheets.findIndex((x) => x.Name === '崇明'), 1);
    const miss = await connect(eventId, { token: mock().token });
    expect(miss.body.steps[1].detail).toContain('缺少工作表：崇明');
    expect(miss.body.overview.binding.enabled).toBe(false);
  });

  it('沿用上次的金山表格：复制其他活动最近使用的链接与令牌（不含模拟）', async () => {
    const a = await createFormalEvent(ctx, { ...FULL, name: '上次的活动' });
    await ctx.db.query(
      `INSERT INTO kdocs_bindings (event_id, webhook_url, token, interval_sec, max_rows, updated_at)
       VALUES ($1, 'https://www.kdocs.cn/api/v3/ide/file/realfile1/script/realscript1/sync_task', 'real-token-abcd', 5, 30, now() + interval '1 hour')`,
      [a],
    );
    const b = await createFormalEvent(ctx, { ...FULL, name: '本次活动' });
    const o = await call(ctx.app, 'GET', api(b), { cookie: ctx.adminCookie });
    expect(o.body.reusable).toMatchObject({ eventName: '上次的活动' });
    expect(JSON.stringify(o.body.reusable)).not.toContain('real-token');
    const r = await connect(b, { reuse: true, enable: false });
    expect(r.body.steps[0]).toMatchObject({ ok: true, detail: '已沿用上次的金山表格' });
    const row = await ctx.db.query('SELECT webhook_url, token, interval_sec, max_rows FROM kdocs_bindings WHERE event_id = $1', [b]);
    expect(row.rows[0]).toEqual({
      webhook_url: 'https://www.kdocs.cn/api/v3/ide/file/realfile1/script/realscript1/sync_task',
      token: 'real-token-abcd',
      interval_sec: 5,
      max_rows: 30,
    });
    await ctx.db.query('DELETE FROM kdocs_bindings WHERE event_id IN ($1, $2)', [a, b]);
  });
});
