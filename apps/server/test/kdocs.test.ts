import { UNITS } from '@bidding/shared';
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

/** 演示活动（模拟金山文档只能用于演示活动） */
async function createDemo(): Promise<string> {
  const r = await call(ctx.app, 'POST', '/api/v1/admin/events', { cookie: ctx.adminCookie, body: { isDemo: true } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.event.id;
}

/** 新演示活动（浦东首轮 30%），绑定模拟金山文档并开启同步（间隔 60 秒，测试中手动触发） */
async function prepared(opts: { live?: boolean; enable?: boolean } = {}) {
  mock().failNext = 0;
  const eventId = await createDemo();
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

/** 单位工作表所在的模拟文件：一个文件模式在总控文件里；每家一个文件模式在「编号-单位代码」文件里 */
const fileOf = (fileId: string, sheet: string) => {
  if (mock().file(fileId)?.sheet(sheet)) return fileId;
  const code = UNITS.find((u) => u.name === sheet)!.code;
  return `${fileId.replace(/hub$/, '')}-${code}`;
};
const cell = (fileId: string, sheet: string, addr: string) => mock().file(fileOf(fileId, sheet))!.sheet(sheet)!.read(addr)[0][0];
const edit = (fileId: string, sheet: string, addr: string, value: unknown) => mock().editCell(fileOf(fileId, sheet), sheet, addr, value);
/** 从概览中取出「单位 链接」清单文本 */
const filesText = (o: any) => (o.binding.unitFiles ?? []).map((f: any) => `${f.unitName} ${f.url}`).join('\n');

/** 领导在「我要加到」（B6）填写 */
const fill = (fileId: string, unitName: string, value: unknown) => edit(fileId, unitName, 'B6', value);
const result = (fileId: string, unitName: string) => String(cell(fileId, unitName, 'B7') ?? '');

describe('AirScript 与接口', () => {
  it('脚本在模拟工作簿中运行：先写后读，缺失工作表如实报告，协议版本不符时拒绝；条件写入与格式', () => {
    const wb = new MockWorkbook('t');
    wb.addSheet('浦东');
    const r = runAirScript(wb, {
      protocol: 1,
      action: 'batch',
      writes: [
        { sheet: '浦东', range: 'B6', values: [['35']] },
        { sheet: '浦东', range: 'B2:B3', values: [['a'], ['b']] },
        { sheet: '闵行', range: 'A1', values: [['x']] },
      ],
      reads: [
        { sheet: '浦东', range: 'B2:B6' },
        { sheet: '闵行', range: 'B6' },
      ],
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.supportsExpect).toBe(true);
    expect(r.written).toBe(2);
    expect(r.missingSheets).toEqual(['闵行']);
    expect(r.reads[0].values).toEqual([['a'], ['b'], [null], [null], ['35']]);
    expect(r.reads[1].values).toBeNull();
    expect((runAirScript(wb, { protocol: 99 }) as any).ok).toBe(false);
    // 条件写入：格子里仍是 35（数字或文本均可比较）才清空；已被改成 40 时跳过
    const c1 = runAirScript(wb, { protocol: 1, writes: [{ sheet: '浦东', range: 'B6', values: [['']], expect: 35 }], reads: [{ sheet: '浦东', range: 'B6' }] }) as any;
    expect(c1).toMatchObject({ written: 1, skipped: 0 });
    expect(c1.reads[0].values).toEqual([[null]]);
    wb.sheet('浦东')!.write('B6', 40);
    const c2 = runAirScript(wb, { protocol: 1, writes: [{ sheet: '浦东', range: 'B6', values: [['']], expect: '35' }], reads: [{ sheet: '浦东', range: 'B6' }] }) as any;
    expect(c2).toMatchObject({ written: 0, skipped: 1 });
    expect(c2.reads[0].values).toEqual([[40]]);
    // 格式：底色、字号、列宽
    const f = runAirScript(wb, { protocol: 1, formats: [{ sheet: '浦东', range: 'B6', fill: 'FFF1B8', fontSize: 22, bold: true, colWidth: 34 }] }) as any;
    expect(f).toMatchObject({ formatted: 1, formatErrors: [] });
    expect(wb.sheet('浦东')!.styles.get('6,2')).toMatchObject({ fill: 'FFF1B8', size: 22, bold: true });
    expect(wb.sheet('浦东')!.colWidths.get(2)).toBe(34);
    // 跨文件读写：与金山一致，同一时刻只能额外打开一个文件；脚本逐个打开、读写、关闭
    const files = new Map<string, MockWorkbook>(['a', 'b', 'c'].map((id) => {
      const f = new MockWorkbook(id);
      f.addSheet(`表${id}`).write('A1', id);
      return [`mock://${id}`, f];
    }));
    const multi = runAirScript(wb, {
      protocol: 1,
      writes: [{ file: 'mock://b', sheet: '表b', range: 'B1', values: [['写入b']] }],
      reads: ['a', 'b', 'c'].map((id) => ({ file: `mock://${id}`, sheet: `表${id}`, range: 'A1:B1' })),
    }, [], (u) => files.get(String(u))!) as any;
    expect(multi.errors).toEqual([]);
    expect(multi.reads.map((x: any) => x.values)).toEqual([[['a', null]], [['b', '写入b']], [['c', null]]]);
    // 在编辑器里直接运行（无参数）：自检，日志说明「云文档API」是否可用
    const logs: string[] = [];
    const self = runAirScript(wb, undefined, logs, () => wb) as any;
    expect(self).toMatchObject({ selfCheck: true, cloudDocs: true, ok: true });
    expect(logs.join('\n')).toContain('「云文档API」服务可用');
    const noDrive = runAirScript(wb, undefined, []) as any;
    expect(noDrive.cloudDocs).toBe(true); // 模拟环境中 KSDrive 对象始终存在，打开文件时才会报错
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
    expect((await err(200, { status: 'finished', error: '高级服务:云文档 未添加!请点击上方服务按钮添加对应服务。', data: {} })).message).toContain('在编辑器里点一次「运行」');
    expect((await err(401, { error: 'bad token' })).kind).toBe('AUTH');
    expect((await err(200, { status: 'finished', error: '', data: { result: null } })).message).toContain('return main(Context.argv)');
    expect((await err(200, { status: 'finished', error: '', data: { result: { protocol: 2 } } })).message).toContain('重新下载脚本');
    expect((await err(429, {})).message).toContain('限流');
  });
});

describe('配置与表格初始化', () => {
  it('使用模拟金山文档：写好 16 家的极简版式与格式；测试连接列出工作表；令牌不回显', async () => {
    const { eventId, fileId } = await prepared({ enable: false });
    expect(cell(fileId, '浦东', 'A1')).toBe('浦东');
    expect(String(cell(fileId, '浦东', 'B1'))).toMatch(/^第一组 · /);
    expect(cell(fileId, '浦东', 'A6')).toBe('我要加到');
    expect(cell(fileId, '崇明', 'A7')).toBe('处理结果');
    expect(String(cell(fileId, '浦东', 'B8'))).toContain('首次填写即视为确认本专场底标');
    const sheet = mock().file(fileOf(fileId, '浦东'))!.sheet('浦东')!;
    expect(sheet.styles.get('6,2')).toMatchObject({ fill: 'FFF1B8', bold: true });
    expect(sheet.styles.get('1,1')).toMatchObject({ fill: 'B91C1C', color: 'FFFFFF' });
    const t = await call(ctx.app, 'POST', api(eventId, '/test'), { cookie: ctx.adminCookie, body: {} });
    expect(t.body.ok).toBe(true);
    expect(t.body.missingUnits).toEqual([]);
    const o = await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie });
    expect(o.body.binding.tokenMasked).toMatch(/^\*\*\*\*/);
    expect(JSON.stringify(o.body)).not.toContain(mock().token);
    expect(o.body.binding.isMock).toBe(true);
  });

  it('旧版式（多行报价表）的残留内容在写入版式时清空', async () => {
    const { eventId, fileId } = await prepared({ enable: false });
    const sheet = mock().file(fileOf(fileId, '浦东'))!.sheet('浦东')!;
    sheet.write('A12:E13', [['序号', '加到（%）', '确认', '处理结果', '处理时间'], [1, 35, '确认', '✔ 已生效', '10:00:00']]);
    sheet.write('C11', '已确认');
    const r = await call(ctx.app, 'POST', api(eventId, '/init-layout'), { cookie: ctx.adminCookie, body: { clearInputs: false } });
    expect(r.status).toBe(200);
    expect(sheet.read('A10:F60').flat().every((v) => v === null)).toBe(true);
    expect(sheet.read('C1:F9').flat().every((v) => v === null)).toBe(true);
  });

  it('同步开启时不能清空填写区；模板只有 A、B 两列，「我要加到」带数字校验，单位表在说明表之前', async () => {
    const { eventId } = await prepared();
    const r = await call(ctx.app, 'POST', api(eventId, '/init-layout'), { cookie: ctx.adminCookie, body: { clearInputs: true } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('先停止同步');
    const res = await ctx.app.inject({ method: 'GET', url: api(eventId, '/template.xlsx'), headers: { cookie: ctx.adminCookie } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...UNITS.map((u) => u.name), '使用说明']);
    const pd = wb.getWorksheet('浦东')!;
    expect(pd.getCell('A6').value).toBe('我要加到');
    expect(pd.getCell('B6').dataValidation?.type).toBe('whole');
    expect(pd.columnCount).toBe(2);
    const zip = await ctx.app.inject({ method: 'GET', url: api(eventId, '/template-files.zip'), headers: { cookie: ctx.adminCookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.rawPayload.includes(Buffer.from('01-浦东.xlsx'))).toBe(true);
    expect(zip.rawPayload.includes(Buffer.from('00-竞标总控（只给工作人员）.xlsx'))).toBe(true);
    const script = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/kdocs/airscript.js', headers: { cookie: ctx.adminCookie } });
    expect(script.body).toContain('return main(Context.argv);');
    expect(script.body).toContain('v1.4.0');
  });

  it('金山表格里还是旧版脚本：测试连接提示重新下载脚本', async () => {
    const respond = (async () =>
      new Response(JSON.stringify({ status: 'finished', error: '', data: { result: { protocol: 1, ok: true, supportsFiles: true, sheets: [], reads: [] } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const { eventId } = await prepared({ enable: false });
    const saved = ctx.kdocs.sync.callOpts.fetchImpl;
    ctx.kdocs.sync.callOpts.fetchImpl = respond;
    try {
      const t = await call(ctx.app, 'POST', api(eventId, '/test'), { cookie: ctx.adminCookie, body: {} });
      expect(t.status).toBe(422);
      expect(t.body.error.message).toContain('需要 1.4.0 及以上');
    } finally {
      ctx.kdocs.sync.callOpts.fetchImpl = saved;
    }
  });
});

describe('通过金山文档竞标', () => {
  it('首次填写即认领底标并加码；读取后清空格子、结果写在 B7；重复、填错、非本组均不会多记；信息区与大屏同步', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'B3'))).toContain('（首次填写即确认）');
    expect(cell(fileId, '浦东', 'B5')).toBe('35 / 40 / 45 / 50');

    // 加到 35%：同时认领底标
    fill(fileId, '浦东', '35');
    const r1 = await syncNow(eventId);
    expect(r1.status.lastRead).toMatchObject({ applied: 1, acked: 1, units: ['浦东'] });
    expect(result(fileId, '浦东')).toMatch(/^✔ 理财已生效：30% → 35%，并确认底标（\d\d:\d\d:\d\d）$/);
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    expect(cell(fileId, '浦东', 'B4')).toBe('35%');
    expect(cell(fileId, '浦东', 'B5')).toBe('40 / 45 / 50 / 55');
    expect(String(cell(fileId, '浦东', 'B3'))).toContain('（已确认）');
    expect(cell(fileId, '浦东', 'B2')).toBe('理财 · 本组竞标中，可以加码');
    const rec = await ctx.db.query(`SELECT source, actor_type, to_pp FROM bid_records WHERE event_id = $1`, [eventId]);
    expect(rec.rows).toEqual([{ source: 'KDOCS', actor_type: 'LEADER', to_pp: 35 }]);
    const ack = await ctx.db.query(`SELECT base_ack_source FROM bid_states WHERE event_id = $1 AND project_code = 'wealth' AND unit_code = 'PD'`, [eventId]);
    expect(ack.rows[0].base_ack_source).toBe('KDOCS');

    // 重复填 35：不重复加码
    fill(fileId, '浦东', 35);
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('✘ 「35」未生效：新增幅 35% 必须高于已确认增幅 35%');
    expect(result(fileId, '浦东')).toContain('请重新填写');
    // 无法识别的数值
    fill(fileId, '浦东', '四十');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('无法识别');
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    // 「40%」也能识别
    fill(fileId, '浦东', '40%');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('已生效：35% → 40%');
    const n = await ctx.db.query(`SELECT count(*)::int AS n, max(to_pp) AS top FROM bid_records WHERE event_id = $1`, [eventId]);
    expect(n.rows[0]).toEqual({ n: 2, top: 40 });

    // 第二组（黄浦）尚未开放：加码不生效
    expect(cell(fileId, '黄浦', 'B2')).toBe('理财 · 竞标中，尚未轮到本组');
    expect(cell(fileId, '黄浦', 'B5')).toBe('轮到本组后可填');
    fill(fileId, '黄浦', '20');
    await syncNow(eventId);
    expect(result(fileId, '黄浦')).toMatch(/✘ 「20」未生效：/);

    // 大屏同步
    const screen = await call(ctx.app, 'GET', `/api/v1/admin/events/${eventId}/state`, { cookie: ctx.adminCookie });
    const pd = screen.body.boards.wealth.flatMap((g: any) => g.rows).find((r: any) => r.unitCode === 'PD');
    expect(pd.currentPp).toBe(40);
  });

  it('读取与清空之间领导改了数字：新数字不会被清掉，下次读取照常处理', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await syncNow(eventId); // 等开放本组后的那次读取完成
    fill(fileId, '浦东', '35');
    // 脚本读到 35 之后、清空之前，领导改成了 40：在第一次调用返回后修改
    const m = mock();
    const orig = m.syncTask.bind(m);
    let calls = 0;
    m.syncTask = async (...args: Parameters<typeof orig>) => {
      const out = await orig(...args);
      if (++calls === 1) fill(fileId, '浦东', '40');
      return out;
    };
    try {
      await syncNow(eventId);
    } finally {
      m.syncTask = orig;
    }
    expect(result(fileId, '浦东')).toContain('已生效：30% → 35%');
    expect(cell(fileId, '浦东', 'B6')).toBe('40');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('已生效：35% → 40%');
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
  });

  it('首次开启前格子里已有的数字不参与竞标并清空（便于反复演练）', async () => {
    const { eventId, fileId } = await prepared({ enable: false, live: true });
    fill(fileId, '浦东', '35');
    await enable(eventId);
    expect(result(fileId, '浦东')).toBe('— 「35」开始读取前已填写，未处理，请重新填写');
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(0);
    // 停用读取期间填写的数字，重新启用后照常处理（不会被当作开启前已填写）
    await enable(eventId, false);
    fill(fileId, '浦东', '35');
    await enable(eventId, true);
    expect(result(fileId, '浦东')).toContain('已生效：30% → 35%');
  });

  it('结束本组前先读取一次：最后一刻的填写仍按开放状态处理', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    fill(fileId, '浦东', '35');
    // 不手动读取，直接结束本组
    const r = await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    expect(r.status).toBe(200);
    expect(r.body.kdocsWarning).toBeUndefined();
    const b = await ctx.db.query('SELECT to_pp FROM bid_records WHERE event_id = $1', [eventId]);
    expect(b.rows).toEqual([{ to_pp: 35 }]);
  });

  it('程序中断（已加码、未记录、未清空）后重新读取：不会重复加码，结果相同', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    // 补记的结果与原来相同（底标已在第一次认领，不再重复提示）
    const strip = (t: string) => t.replace(/（\d\d:\d\d:\d\d）/, '').replace('，并确认底标', '');
    const before = strip(result(fileId, '浦东'));
    // 模拟「已加码但处理记录未写入、格子未清空」：删除处理记录、把数字放回去并重启同步
    await ctx.db.query('DELETE FROM kdocs_rows WHERE event_id = $1', [eventId]);
    await enable(eventId, false);
    fill(fileId, '浦东', '35');
    await enable(eventId, true);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(1);
    expect(strip(result(fileId, '浦东'))).toBe(before);
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
  });

  it('写回结果前中断：重启后上次处理过的数字还留在格子里，不会再处理', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await syncNow(eventId); // 等开放本组后的那次读取完成
    fill(fileId, '浦东', '35');
    // 第二次调用（写回结果与清空）失败
    const m = mock();
    const orig = m.syncTask.bind(m);
    let calls = 0;
    m.syncTask = async (...args: Parameters<typeof orig>) => (++calls === 2 ? { httpStatus: 503, body: { error: '模拟：中断' } } : orig(...args));
    try {
      await syncNow(eventId).catch(() => {});
    } finally {
      m.syncTask = orig;
    }
    expect(cell(fileId, '浦东', 'B6')).toBe('35');
    await enable(eventId, false);
    await enable(eventId, true);
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM kdocs_rows WHERE event_id = $1`, [eventId]);
    expect(n.rows[0].n).toBe(1);
    expect(result(fileId, '浦东')).toContain('已生效：30% → 35%');
  });

  it('换专场：基金专场第一次填写时再认领基金底标', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    expect((await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true })).status).toBe(200);
    await goLive(ctx, eventId, 'fund', 1);
    await syncNow(eventId);
    expect(String(cell(fileId, '浦东', 'B2'))).toContain('基金 · ');
    expect(String(cell(fileId, '浦东', 'B3'))).toContain('（首次填写即确认）');
    const ack = await ctx.db.query(`SELECT base_ack_at FROM bid_states WHERE event_id = $1 AND project_code = 'fund' AND unit_code = 'PD'`, [eventId]);
    expect(ack.rows[0].base_ack_at).toBeNull();
    const first = String(cell(fileId, '浦东', 'B5')).split(' / ')[0];
    fill(fileId, '浦东', first);
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('基金已生效');
    expect(result(fileId, '浦东')).toContain('并确认底标');
    const src = await ctx.db.query(`SELECT base_ack_source FROM bid_states WHERE event_id = $1 AND project_code = 'fund' AND unit_code = 'PD'`, [eventId]);
    expect(src.rows[0].base_ack_source).toBe('KDOCS');
  });

  it('金山文档不可用：显示错误、不阻塞现场操作，恢复后自动继续', async () => {
    const { eventId, fileId } = await prepared({ live: true });
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
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('已生效');
    const o2 = await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie });
    expect(o2.body.status.state).toBe('RUNNING');
    expect(o2.body.counts.APPLIED).toBe(1);
  });

  it('后台定时读取（不手动触发）：填写后自动生效并清空', async () => {
    const { eventId, fileId } = await prepared({ enable: false, live: true });
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: true, intervalSec: 1, autoSync: true } });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 200));
      return cond();
    };
    expect(await waitFor(() => cell(fileId, '浦东', 'B4') === '30%')).toBe(true);
    fill(fileId, '浦东', '35');
    expect(await waitFor(() => result(fileId, '浦东').includes('已生效'))).toBe(true);
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
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
    const oa = (await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie })).body;
    // 新活动直接粘贴同一个链接、令牌和 16 家单位文件链接
    const b = await createDemo();
    const r = await connect(b, { webhookUrl: oa.binding.webhookUrl, token: mock().token, unitFiles: filesText(oa) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.steps.map((x: any) => [x.name, x.ok])).toEqual([
      ['保存链接与令牌', true],
      ['测试连接', true],
      ['写入表格版式', true],
      ['启用读取', true],
    ]);
    expect(r.body.overview.binding.enabled).toBe(true);
    expect(String(cell(fileId, '浦东', 'B1'))).toMatch(/^第一组 · 【演示】/);
  });

  it('同一张表格改由新活动同步时，旧活动的同步自动停止', async () => {
    const { eventId: a } = await prepared();
    const oa = (await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie })).body;
    const b = await createDemo();
    const r = await connect(b, { webhookUrl: oa.binding.webhookUrl, token: mock().token, unitFiles: filesText(oa) });
    expect(r.body.steps.at(-1).detail).toContain('读取已自动停止');
    const after = await call(ctx.app, 'GET', api(a), { cookie: ctx.adminCookie });
    expect(after.body.binding.enabled).toBe(false);
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
    const wb = mock().file(fileOf(fileId, '崇明'))!;
    wb.sheets.splice(wb.sheets.findIndex((x) => x.Name === '崇明'), 1);
    const miss = await connect(eventId, { token: mock().token });
    expect(miss.body.steps[1].detail).toContain('崇明：文件中没有名为「崇明」的工作表');
    expect(miss.body.overview.binding.enabled).toBe(false);
  });

  it('沿用上次的金山表格：复制其他活动最近使用的链接与令牌（不含模拟）', async () => {
    const a = await createFormalEvent(ctx, { ...FULL, name: '上次的活动' });
    await ctx.db.query(
      `INSERT INTO kdocs_bindings (event_id, webhook_url, token, interval_sec, max_rows, updated_at, unit_files)
       VALUES ($1, 'https://www.kdocs.cn/api/v3/ide/file/realfile1/script/realscript1/sync_task', 'real-token-abcd', 5, 30, now() + interval '1 hour', $2)`,
      [a, JSON.stringify(Object.fromEntries(UNITS.map((u) => [u.code, `https://www.kdocs.cn/l/real-${u.code}`])))],
    );
    const b = await createFormalEvent(ctx, { ...FULL, name: '本次活动' });
    const o = await call(ctx.app, 'GET', api(b), { cookie: ctx.adminCookie });
    expect(o.body.reusable).toMatchObject({ eventName: '上次的活动' });
    expect(JSON.stringify(o.body.reusable)).not.toContain('real-token');
    const r = await connect(b, { reuse: true, enable: false });
    expect(r.body.steps[0]).toMatchObject({ ok: true, detail: '已沿用上次的金山表格' });
    const row = await ctx.db.query('SELECT webhook_url, token, interval_sec, unit_files FROM kdocs_bindings WHERE event_id = $1', [b]);
    expect(row.rows[0]).toMatchObject({
      webhook_url: 'https://www.kdocs.cn/api/v3/ide/file/realfile1/script/realscript1/sync_task',
      token: 'real-token-abcd',
      interval_sec: 5,
    });
    expect(row.rows[0].unit_files.PD).toBe('https://www.kdocs.cn/l/real-PD');
    await ctx.db.query('DELETE FROM kdocs_bindings WHERE event_id IN ($1, $2)', [a, b]);
  });
});

describe('每家单位一个文件（各单位互相看不到）', () => {
  it('浦东的文件里只有浦东的工作表；读写都落在各自文件中', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    expect(fileId).toMatch(/hub$/);
    const pdFile = mock().file(fileOf(fileId, '浦东'))!;
    expect(pdFile.sheets.map((x) => x.Name)).toEqual(['浦东', '使用说明']);
    expect(mock().file(fileId)!.sheets.map((x) => x.Name)).toEqual(['使用说明']);
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('已生效：30% → 35%');
    // 闵行文件中看不到浦东的任何内容
    const mhFile = mock().file(fileOf(fileId, '闵行'))!;
    expect(JSON.stringify(mhFile.sheets.map((x) => x.read('A1:F60')))).not.toContain('浦东');
  });

  it('扫码填报卡：每家单位一张，二维码指向本单位的文件；一个文件 16 张工作表时不提供', async () => {
    const { eventId } = await prepared({ enable: false });
    const r = await call(ctx.app, 'GET', api(eventId, '/cards'), { cookie: ctx.adminCookie });
    expect(r.status).toBe(200);
    expect(r.body.cards).toHaveLength(16);
    expect(r.body.isMock).toBe(true);
    const pd = r.body.cards.find((c: any) => c.unitCode === 'PD');
    expect(pd.url).toMatch(/\/mock-kdocs\?file=mock[0-9a-f]+-PD$/);
    expect(pd.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const single = await createDemo();
    await call(ctx.app, 'POST', api(single, '/use-mock'), { cookie: ctx.adminCookie, body: { mode: 'single' } });
    const r2 = await call(ctx.app, 'GET', api(single, '/cards'), { cookie: ctx.adminCookie });
    expect(r2.status).toBe(422);
    expect(r2.body.error.message).toContain('每家单位一个文件');
  });

  it('单位文件链接清单：缺单位、重复链接、无法识别的行都会提示', async () => {
    const { eventId } = await prepared({ enable: false });
    const put = (unitFiles: string) => call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { unitFiles } });
    const r1 = await put('浦东 mock://a1\n闵行 mock://a2');
    expect(r1.body.error.message).toContain('还缺 14 家');
    const r2 = await put(UNITS.map((u) => `${u.name} mock://same`).join('\n'));
    expect(r2.body.error.message).toContain('用了同一个文件链接');
    const r3 = await put('浦东 http://example.com/x');
    expect(r3.body.error.message).toContain('无法识别链接');
  });

  it('某家单位的文件打不开：测试连接指出是哪家', async () => {
    const { eventId } = await prepared({ enable: false });
    const o = (await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie })).body;
    const text = filesText(o).replace(/浦东 mock:\/\/\S+/, '浦东 mock://nosuchfile');
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { unitFiles: text } });
    const r = await call(ctx.app, 'POST', api(eventId, '/connect'), { cookie: ctx.adminCookie, body: {} });
    expect(r.body.steps[1].ok).toBe(false);
    expect(r.body.steps[1].detail).toContain('浦东：无法打开文件');
  });

  it('一个文件 16 张工作表的方式仍可使用', async () => {
    mock().failNext = 0;
    const eventId = await createDemo();
    await importRows(ctx, eventId, fullRows('wealth', { pp: (c, m) => (c === 'PD' ? 30 : m) }));
    const m = await call(ctx.app, 'POST', api(eventId, '/use-mock'), { cookie: ctx.adminCookie, body: { mode: 'single' } });
    const fileId: string = m.body.mockFileId;
    expect(m.body.binding.mode).toBe('single');
    expect(mock().file(fileId)!.sheets).toHaveLength(17);
    await enable(eventId);
    await goLive(ctx, eventId, 'wealth', 1);
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('已生效');
    await enable(eventId, false);
  });
});

describe('按需同步（减少金山文档调用次数）', () => {
  it('首轮未发布 30 秒、等待/组间/暂停 10 秒、竞标中按配置间隔、全部锁定后停止；现场操作后立即同步', async () => {
    const { eventId } = await prepared({ enable: false });
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: true, intervalSec: 3, autoSync: true } });
    const status = async () => (await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie })).body.status;
    const waitPace = async (pace: string) => {
      for (let i = 0; i < 50; i++) {
        const st = await status();
        if (st?.pace === pace) return st;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`节奏未变为 ${pace}：${JSON.stringify(await status())}`);
    };
    const delay = (st: any) => (new Date(st.nextSyncAt).getTime() - new Date(st.lastOkAt).getTime()) / 1000;

    let st = await waitPace('COLD');
    expect(delay(st)).toBeGreaterThanOrEqual(29);

    const calls0 = st.calls;
    await goLive(ctx, eventId, 'wealth', 1); // 发布 + 开始并开放第一组：立即同步
    st = await waitPace('HOT');
    expect(st.calls).toBeGreaterThan(calls0);
    expect(delay(st)).toBeLessThanOrEqual(3.5);

    await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
    st = await waitPace('WARM');
    expect(delay(st)).toBeGreaterThanOrEqual(9);

    await control(ctx, eventId, 'wealth', 'PAUSE');
    await control(ctx, eventId, 'wealth', 'LOCK', { confirm: true });
    await importRows(ctx, eventId, fullRows('fund', { base: () => '200' }));
    await goLive(ctx, eventId, 'fund', 1);
    await waitPace('HOT');
    await control(ctx, eventId, 'fund', 'PAUSE');
    await control(ctx, eventId, 'fund', 'LOCK', { confirm: true });
    st = await waitPace('IDLE');
    expect(st.nextSyncAt).toBeNull();
    // 停止自动同步后，「立即同步」仍可用
    await syncNow(eventId);
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: false } });
  }, 30_000);
});

describe('手动读取（默认）', () => {
  it('启用后只读取一次（标记同步前已填写），之后不自动读取；点「读取」才处理，并返回本次结果', async () => {
    const { eventId, fileId } = await prepared({ enable: false, live: true });
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: true, intervalSec: 1 } });
    const status = async () => (await call(ctx.app, 'GET', api(eventId), { cookie: ctx.adminCookie })).body.status;
    for (let i = 0; i < 30 && !(await status())?.lastOkAt; i++) await new Promise((r) => setTimeout(r, 100));
    const first = await status();
    expect(first.autoSync).toBe(false);
    expect(first.nextSyncAt).toBeNull();
    // 领导填写后等 2.5 秒：不会被自动读取
    const callsBefore = (await status()).calls;
    fill(fileId, '浦东', '35');
    await new Promise((r) => setTimeout(r, 2500));
    expect((await status()).calls).toBe(callsBefore);
    expect(cell(fileId, '浦东', 'B6')).toBe('35');
    // 手动读取：处理并返回结果摘要
    const r = await syncNow(eventId);
    expect(r.status.lastRead).toMatchObject({ applied: 1, rejected: 0, acked: 1, units: ['浦东'] });
    expect(result(fileId, '浦东')).toContain('已生效');
    await call(ctx.app, 'PUT', api(eventId), { cookie: ctx.adminCookie, body: { enabled: false } });
  }, 30_000);
});

describe('审查报告修复（F01–F05）', () => {
  const pdSheet = (fileId: string) => mock().file(fileOf(fileId, '浦东'))!.sheet('浦东')!;

  it('F01：高值报价不自动通过确认，提示由工作人员核实代录', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await ctx.db.query(`UPDATE events SET config = config || '{"highValueConfirmPp": 35}'::jsonb WHERE id = $1`, [eventId]);
    fill(fileId, '浦东', '35');
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('增幅较大（35%），需要工作人员核实');
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('F01：数字 1 按 1% 处理（不会变成 100%）', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    fill(fileId, '浦东', 1);
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toContain('✘ 「1」未生效');
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('F02：有单位没读到时，结束本组被拦截；填写原因可强制执行并记入审计', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    const sheet = pdSheet(fileId);
    sheet.Name = '浦东（改名）';
    try {
      const r = await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('KDOCS_INCOMPLETE');
      expect(r.body.error.message).toContain('浦东');
      expect(r.body.error.details.units).toEqual(['浦东']);
      const noReason = await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1, kdocsForce: true });
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');
      const forced = await control(ctx, eventId, 'wealth', 'CLOSE_GROUP', { groupNo: 1, kdocsForce: true, kdocsForceReason: '浦东电话确认无新报价' });
      expect(forced.status).toBe(200);
      expect(forced.body.kdocsWarning).toContain('浦东');
      const a = await ctx.db.query(`SELECT reason, details FROM audit_logs WHERE event_id = $1 AND action = 'KDOCS_FORCE'`, [eventId]);
      expect(a.rows[0].reason).toBe('浦东电话确认无新报价');
      expect(a.rows[0].details.units).toEqual(['浦东']);
    } finally {
      sheet.Name = '浦东';
    }
  });

  it('F03：结果写不回表格时不算送达；重试期间同一数字不会被当成新报价，恢复后补写成功结果', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await syncNow(eventId);
    const sheet = pdSheet(fileId);
    const realWrite = sheet.write.bind(sheet);
    fill(fileId, '浦东', '35');
    sheet.write = () => {
      throw new Error('没有编辑权限');
    };
    try {
      const r1 = await syncNow(eventId);
      expect(r1.status.lastRead.applied).toBe(1);
      expect(r1.status.undelivered).toEqual(['浦东']);
      expect(cell(fileId, '浦东', 'B6')).toBe('35');
      // 仍写不回：再次读取，同一个 35 不会被当成新报价
      const r2 = await syncNow(eventId);
      expect(r2.status.lastRead).toMatchObject({ applied: 0, rejected: 0 });
      const rows = await ctx.db.query('SELECT count(*)::int AS n, bool_or(cleared) AS cleared FROM kdocs_rows WHERE event_id = $1', [eventId]);
      expect(rows.rows[0]).toEqual({ n: 1, cleared: false });
    } finally {
      sheet.write = realWrite;
    }
    const r3 = await syncNow(eventId);
    expect(r3.status.undelivered).toEqual([]);
    expect(result(fileId, '浦东')).toContain('✔ 理财已生效：30% → 35%');
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('F04：正式活动不能使用模拟金山文档；模拟文件编号随机、无法从活动编号推出', async () => {
    const formal = await createFormalEvent(ctx);
    const r = await call(ctx.app, 'POST', api(formal, '/use-mock'), { cookie: ctx.adminCookie, body: {} });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('DEMO_ONLY');
    const p = await call(ctx.app, 'PUT', api(formal), {
      cookie: ctx.adminCookie,
      body: { webhookUrl: 'http://127.0.0.1:8080/mock-kdocs/api/v3/ide/file/mockx/script/s/sync_task', token: 't' },
    });
    expect(p.body.error.code).toBe('DEMO_ONLY');
    const { eventId, fileId } = await prepared({ enable: false });
    expect(fileId).not.toContain(eventId.replace(/-/g, '').slice(0, 12));
    expect(fileId).toMatch(/^mock[0-9a-f]{20}hub$/);
  });

  it('F05：暂停期间填写的数字，恢复前按暂停状态处理（不生效），恢复后不会被受理', async () => {
    const { eventId, fileId } = await prepared({ live: true });
    await control(ctx, eventId, 'wealth', 'PAUSE');
    fill(fileId, '浦东', '35');
    const r = await control(ctx, eventId, 'wealth', 'RESUME');
    expect(r.status).toBe(200);
    await syncNow(eventId);
    expect(result(fileId, '浦东')).toMatch(/✘ 「35」未生效：.*暂停/);
    expect(cell(fileId, '浦东', 'B6')).toBeNull();
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM bid_records WHERE event_id = $1', [eventId]);
    expect(n.rows[0].n).toBe(0);
  });
});
