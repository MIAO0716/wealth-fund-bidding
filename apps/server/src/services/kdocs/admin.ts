/**
 * 金山文档接入的管理操作：保存配置、测试连接、初始化表格版式、改用模拟金山文档、查看处理记录。
 */

import { randomBytes } from 'node:crypto';
import { GROUP_BY_NO, KDOCS_LAYOUT, type KdocsFormat, type KdocsWrite, UNITS, parseUnitFiles } from '@bidding/shared';
import { withTx } from '../../db/pool';
import { bizError } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { type Actor, audit } from '../core';
import type { AppContext } from '../context';
import { qrDataUrl, wifiInfo } from '../auth';
import { getEventRow, readConfig } from '../events';
import { KdocsError, OLD_SCRIPT_MESSAGE, callScript, isCurrentScript, isMockUrl, normalizeWebhookUrl } from './client';
import type { KdocsMock } from './mock';
import { KDOCS_COLORS } from './template';
import type { KdocsBindingRow, KdocsSyncManager } from './sync';

const MOCK_DEMO_ONLY = '模拟金山文档只能用于演示活动；正式活动请连接真实金山文档';

export interface KdocsDeps {
  ctx: AppContext;
  sync: KdocsSyncManager;
  mock: KdocsMock | null;
}

function maskToken(t: string): string {
  return t.length <= 4 ? '****' : `****${t.slice(-4)}`;
}

export function bindingView(b: KdocsBindingRow | null) {
  if (!b) return null;
  return {
    webhookUrl: b.webhook_url,
    tokenMasked: maskToken(b.token),
    intervalSec: b.interval_sec,
    enabled: b.enabled,
    baselineDone: b.baseline_done,
    enabledAt: toIso(b.enabled_at),
    updatedAt: toIso(b.updated_at),
    isMock: isMockUrl(b.webhook_url),
    mode: b.unit_files ? ('files' as const) : ('single' as const),
    autoSync: b.auto_sync,
    unitFiles: b.unit_files
      ? UNITS.map((u) => ({ unitCode: u.code, unitName: u.name, url: b.unit_files![u.code] ?? null }))
      : null,
  };
}

/** 单位文件清单的文本形式（每行「单位 链接」），用于表单回显 */
export function unitFilesText(files: Record<string, string> | null): string {
  if (!files) return '';
  return UNITS.filter((u) => files[u.code]).map((u) => `${u.name} ${files[u.code]}`).join('\n');
}

export async function getKdocsOverview(d: KdocsDeps, eventId: string) {
  const b = await d.sync.binding(eventId);
  const rows = await d.ctx.db.query(
    `SELECT unit_code, row_no, target_raw, status, project_code, from_pp, to_pp, receipt_no, message, first_seen_at
       FROM kdocs_rows WHERE event_id = $1 ORDER BY first_seen_at DESC, unit_code, row_no LIMIT 100`,
    [eventId],
  );
  const counts = await d.ctx.db.query(`SELECT status, count(*)::int AS n FROM kdocs_rows WHERE event_id = $1 GROUP BY status`, [eventId]);
  return {
    binding: bindingView(b),
    status: d.sync.status(eventId),
    mockAvailable: !!d.mock,
    reusable: await reusableBinding(d, eventId),
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    rows: rows.rows.map((r) => ({
      unitCode: r.unit_code,
      unitName: UNITS.find((u) => u.code === r.unit_code)?.name ?? r.unit_code,
      rowNo: r.row_no,
      targetRaw: r.target_raw,
      status: r.status,
      projectCode: r.project_code,
      fromPp: r.from_pp,
      toPp: r.to_pp,
      receiptNo: r.receipt_no,
      message: r.message,
      seenAt: toIso(r.first_seen_at),
    })),
  };
}

export async function saveKdocsBinding(
  d: KdocsDeps,
  eventId: string,
  actor: Actor,
  body: { webhookUrl?: unknown; token?: unknown; intervalSec?: unknown; enabled?: unknown; unitFiles?: unknown; autoSync?: unknown },
) {
  if (d.ctx.config.readOnly) throw bizError('READ_ONLY');
  const ev = await getEventRow(d.ctx.db, eventId);
  const existing = await d.sync.binding(eventId);
  let webhookUrl = existing?.webhook_url ?? '';
  if (body.webhookUrl !== undefined) {
    try {
      webhookUrl = normalizeWebhookUrl(body.webhookUrl);
    } catch (e) {
      throw bizError('BAD_REQUEST', (e as Error).message);
    }
  }
  if (!webhookUrl) throw bizError('BAD_REQUEST', '请填写脚本 webhook 链接');
  // 模拟金山文档只用于演练：正式活动不能绑定（模拟表格谁拿到链接都能填写）
  if (isMockUrl(webhookUrl) && !ev.is_demo) throw bizError('DEMO_ONLY', MOCK_DEMO_ONLY);
  let token = existing?.token ?? '';
  if (typeof body.token === 'string' && body.token.trim()) token = body.token.trim();
  if (!token) throw bizError('BAD_REQUEST', '请填写脚本令牌');
  if (token.length > 500) throw bizError('BAD_REQUEST', '脚本令牌过长');
  const intervalSec = body.intervalSec === undefined ? (existing?.interval_sec ?? 3) : Number(body.intervalSec);
  if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > 60) throw bizError('BAD_REQUEST', '同步间隔须为 1–60 秒');
  // max_rows 为旧版式（多行报价表）遗留字段，极简版式不再使用
  const maxRows = existing?.max_rows ?? 40;
  const enabled = body.enabled === undefined ? (existing?.enabled ?? false) : body.enabled === true;
  const autoSync = body.autoSync === undefined ? (existing?.auto_sync ?? false) : body.autoSync === true;
  // 每家单位一个文件：解析「单位 链接」清单；传空字符串或 null 表示一个文件 16 张工作表
  let unitFiles: Record<string, string> | null = existing?.unit_files ?? null;
  if (body.unitFiles !== undefined) {
    if (body.unitFiles === null || (typeof body.unitFiles === 'string' && !body.unitFiles.trim())) {
      unitFiles = null;
    } else if (typeof body.unitFiles === 'string') {
      const parsed = parseUnitFiles(body.unitFiles, UNITS, isMockUrl(webhookUrl));
      if (parsed.errors.length) throw bizError('BAD_REQUEST', `单位文件链接有误：${parsed.errors.slice(0, 3).join('；')}`);
      if (parsed.missing.length) throw bizError('BAD_REQUEST', `还缺 ${parsed.missing.length} 家单位的文件链接：${parsed.missing.join('、')}`);
      unitFiles = parsed.files;
    } else if (typeof body.unitFiles === 'object') {
      unitFiles = body.unitFiles as Record<string, string>;
    }
  }
  // 换了表格：重新标记「开始同步前已填写」
  const docChanged = !existing || existing.webhook_url !== webhookUrl || JSON.stringify(existing.unit_files) !== JSON.stringify(unitFiles);

  await d.ctx.db.query(
    `INSERT INTO kdocs_bindings (event_id, webhook_url, token, interval_sec, max_rows, enabled, baseline_done, enabled_at, updated_at, unit_files, auto_sync)
     VALUES ($1, $2, $3, $4, $5, $6, false, CASE WHEN $6 THEN now() END, now(), $8, $9)
     ON CONFLICT (event_id) DO UPDATE SET
       webhook_url = EXCLUDED.webhook_url, token = EXCLUDED.token, interval_sec = EXCLUDED.interval_sec,
       max_rows = EXCLUDED.max_rows, enabled = EXCLUDED.enabled, unit_files = EXCLUDED.unit_files, auto_sync = EXCLUDED.auto_sync,
       baseline_done = CASE WHEN $7 THEN false ELSE kdocs_bindings.baseline_done END,
       enabled_at = CASE WHEN EXCLUDED.enabled AND NOT kdocs_bindings.enabled THEN now() ELSE kdocs_bindings.enabled_at END,
       updated_at = now()`,
    [eventId, webhookUrl, token, intervalSec, maxRows, enabled, docChanged, unitFiles ? JSON.stringify(unitFiles) : null, autoSync],
  );
  if (!existing || existing.enabled !== enabled || docChanged) {
    await withTx(d.ctx.db, (tx) =>
      audit(tx, eventId, actor, enabled ? 'KDOCS_SYNC_ON' : 'KDOCS_SYNC_OFF', {
        details: { webhookUrl: isMockUrl(webhookUrl) ? '模拟金山文档' : webhookUrl.replace(/\/file\/[^/]+/, '/file/…'), intervalSec },
      }),
    );
  }
  // 同一张表格只能由一个活动同步：开启本活动时停止其他活动对这张表格的同步
  const stoppedEvents: string[] = [];
  if (enabled) {
    const others = await d.ctx.db.query(
      `UPDATE kdocs_bindings SET enabled = false, updated_at = now()
        WHERE webhook_url = $1 AND event_id <> $2 AND enabled
        RETURNING event_id`,
      [webhookUrl, eventId],
    );
    for (const o of others.rows) {
      const ev = await getEventRow(d.ctx.db, o.event_id);
      stoppedEvents.push(String((ev.config as { name?: string }).name || '（未命名活动）'));
      await withTx(d.ctx.db, (tx) => audit(tx, o.event_id, actor, 'KDOCS_SYNC_OFF', { reason: '同一张金山表格已改由其他活动同步', details: { toEventId: eventId } }));
      await d.sync.refresh(o.event_id);
    }
  }
  await d.sync.refresh(eventId);
  return { ...(await getKdocsOverview(d, eventId)), stoppedEvents };
}

/** 其他活动最近使用过的真实金山表格（不含模拟），用于新活动「沿用上次的金山表格」 */
async function reusableBinding(d: KdocsDeps, eventId: string) {
  const r = await d.ctx.db.query(
    `SELECT b.event_id, b.webhook_url, b.updated_at, e.config
       FROM kdocs_bindings b JOIN events e ON e.id = b.event_id
      WHERE b.event_id <> $1 AND b.webhook_url NOT LIKE '%/mock-kdocs/%'
      ORDER BY b.updated_at DESC LIMIT 1`,
    [eventId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    eventId: row.event_id as string,
    eventName: String((row.config as { name?: string }).name || '（未命名活动）'),
    webhookUrl: row.webhook_url as string,
    updatedAt: toIso(row.updated_at),
  };
}

export interface ConnectStep {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 一键连接：保存 → 测试连接（16 张工作表齐全）→ 写入表格版式 → 开启同步，逐项返回结果，任一步失败即停止。
 * reuse=true 时沿用其他活动最近使用的金山表格（链接与令牌）。
 */
export async function connectKdocs(
  d: KdocsDeps,
  eventId: string,
  actor: Actor,
  body: { webhookUrl?: unknown; token?: unknown; reuse?: unknown; enable?: unknown; unitFiles?: unknown },
) {
  if (d.ctx.config.readOnly) throw bizError('READ_ONLY');
  const steps: ConnectStep[] = [];
  const enable = body.enable !== false;
  const existing = await d.sync.binding(eventId);

  let source: { webhookUrl?: unknown; token?: unknown; intervalSec?: number; unitFiles?: unknown } = {
    webhookUrl: body.webhookUrl,
    token: body.token,
    unitFiles: body.unitFiles,
  };
  if (body.reuse === true) {
    const r = await d.ctx.db.query(
      `SELECT webhook_url, token, interval_sec, unit_files FROM kdocs_bindings
        WHERE event_id <> $1 AND webhook_url NOT LIKE '%/mock-kdocs/%' ORDER BY updated_at DESC LIMIT 1`,
      [eventId],
    );
    if (!r.rowCount) throw bizError('BAD_REQUEST', '没有可以沿用的金山表格，请粘贴 webhook 链接和脚本令牌');
    const row = r.rows[0];
    source = { webhookUrl: row.webhook_url, token: row.token, intervalSec: row.interval_sec, unitFiles: row.unit_files ?? null };
  }
  const webhookGiven = typeof source.webhookUrl === 'string' && source.webhookUrl.trim() !== '';
  const keepRunning = !!existing?.enabled && (!webhookGiven || existing.webhook_url === String(source.webhookUrl).trim());

  // 1. 保存（换表格时先停止同步，测试通过后再开启）
  try {
    await saveKdocsBinding(d, eventId, actor, {
      ...(webhookGiven ? { webhookUrl: source.webhookUrl } : {}),
      token: source.token,
      ...(source.unitFiles !== undefined ? { unitFiles: source.unitFiles } : {}),
      ...(source.intervalSec ? { intervalSec: source.intervalSec } : {}),
      enabled: keepRunning,
    });
    steps.push({ name: '保存链接与令牌', ok: true, detail: body.reuse === true ? '已沿用上次的金山表格' : '已保存' });
  } catch (e) {
    steps.push({ name: '保存链接与令牌', ok: false, detail: (e as Error).message });
    return { ok: false, steps, overview: await getKdocsOverview(d, eventId) };
  }

  // 2. 测试连接
  try {
    const t = (await testKdocs(d, eventId))!;
    if (t.missingUnits.length) {
      steps.push({
        name: '测试连接',
        ok: false,
        detail: t.unitErrors.length
          ? `已连上总控脚本，但有 ${t.missingUnits.length} 家单位的文件打不开或工作表名称不对：${t.unitErrors.slice(0, 3).join('；')}`
          : `已连上，但缺少工作表：${t.missingUnits.join('、')}。请确认导入的是管理端下载的模板，且工作表名称未修改`,
      });
      return { ok: false, steps, overview: await getKdocsOverview(d, eventId) };
    }
    const modeText = (await d.sync.binding(eventId))?.unit_files ? '16 家单位文件都能打开' : '16 家单位工作表齐全';
    steps.push({ name: '测试连接', ok: true, detail: `连接成功（${t.durationMs} 毫秒），${modeText}` });
  } catch (e) {
    steps.push({ name: '测试连接', ok: false, detail: (e as Error).message });
    return { ok: false, steps, overview: await getKdocsOverview(d, eventId) };
  }

  // 3. 写入版式（不改动领导已填写的内容）
  try {
    const r = (await initKdocsLayout(d, eventId, actor, { clearInputs: false }))!;
    const fmt = r.formatErrors.length ? `；部分格式金山不支持，已忽略（${r.formatErrors.length} 项，不影响使用）` : '';
    steps.push({ name: '写入表格版式', ok: true, detail: `已写入标题、标签与格式（${r.written} 处内容、${r.formatted} 处格式${fmt}）` });
  } catch (e) {
    steps.push({ name: '写入表格版式', ok: false, detail: (e as Error).message });
    return { ok: false, steps, overview: await getKdocsOverview(d, eventId) };
  }

  // 4. 开启同步
  if (enable) {
    try {
      const r = await saveKdocsBinding(d, eventId, actor, { enabled: true });
      const extra = r.stoppedEvents.length ? `；这张表格在「${r.stoppedEvents.join('」「')}」上的读取已自动停止` : '';
      const how = r.binding?.autoSync ? '自动定时读取' : '手动读取：看到表格有变化时点「读取金山表格」';
      steps.push({ name: '启用读取', ok: true, detail: `${keepRunning ? '保持启用' : '已启用'}（${how}）${extra}` });
    } catch (e) {
      steps.push({ name: '启用读取', ok: false, detail: (e as Error).message });
      return { ok: false, steps, overview: await getKdocsOverview(d, eventId) };
    }
  }
  return { ok: true, steps, overview: await getKdocsOverview(d, eventId) };
}

async function requireBinding(d: KdocsDeps, eventId: string): Promise<KdocsBindingRow> {
  const b = await d.sync.binding(eventId);
  if (!b) throw bizError('BAD_REQUEST', '请先填写并保存金山文档配置');
  return b;
}

function kdocsBizError(e: unknown): never {
  if (e instanceof KdocsError) throw bizError('BAD_REQUEST', e.message);
  throw e;
}

/**
 * 测试连接：调用一次脚本，检查 16 家单位的工作表是否齐全。
 * 每家单位一个文件时，逐个打开单位文件，读取 A1，确认文件可打开、工作表名称正确。
 */
export async function testKdocs(d: KdocsDeps, eventId: string) {
  const b = await requireBinding(d, eventId);
  const started = Date.now();
  try {
    if (!b.unit_files) {
      const r = await callScript(b.webhook_url, b.token, { action: 'ping' }, d.sync.callOpts);
      if (!isCurrentScript(r)) throw new KdocsError(OLD_SCRIPT_MESSAGE, 'PROTOCOL');
      const sheets = r.sheets ?? [];
      return {
        ok: true,
        durationMs: Date.now() - started,
        sheets,
        missingUnits: UNITS.filter((u) => !sheets.includes(u.name)).map((u) => u.name),
        unitErrors: [] as string[],
      };
    }
    const reads = UNITS.map((u) => ({ file: b.unit_files![u.code], sheet: u.name, range: 'A1' }));
    const r = await callScript(b.webhook_url, b.token, { action: 'batch', reads }, d.sync.callOpts);
    if (!isCurrentScript(r)) throw new KdocsError(OLD_SCRIPT_MESSAGE, 'PROTOCOL');
    const bad = (r.reads ?? []).filter((x) => x.values === null);
    return {
      ok: true,
      durationMs: Date.now() - started,
      sheets: r.sheets ?? [],
      missingUnits: bad.map((x) => x.sheet),
      unitErrors: bad.map((x) => `${x.sheet}：${x.error ?? '文件中没有名为「' + x.sheet + '」的工作表'}`),
    };
  } catch (e) {
    kdocsBizError(e);
  }
}

/**
 * 版式写入指令：标题、标签、说明；clearInputs 时同时清空「我要加到」、处理结果与信息区。
 * 同时清空旧版式（多行报价表）的残留内容。
 */
export function layoutWrites(clearInputs: boolean, title: string, unitFiles: Record<string, string> | null = null): KdocsWrite[] {
  const L = KDOCS_LAYOUT;
  const out: KdocsWrite[] = [];
  for (const u of UNITS) {
    const s = u.name;
    const file = unitFiles?.[u.code];
    const start = out.length;
    out.push({ sheet: s, range: 'A1:B1', values: [[u.name, `${GROUP_BY_NO.get(u.groupNo)!.name} · ${title}`]] });
    out.push({ sheet: s, range: `A2:A${L.lastRow}`, values: L.labels.map((l) => [l]) });
    out.push({ sheet: s, range: L.noteCell, values: [[L.note]] });
    for (const r of L.legacyRanges) out.push({ sheet: s, range: r, values: blankGrid(r) });
    if (clearInputs) {
      out.push({ sheet: s, range: L.infoValueRange, values: [[''], [''], [''], ['']] });
      out.push({ sheet: s, range: `${L.inputCell}:${L.resultCell}`, values: [[''], ['']] });
      out.push({ sheet: s, range: L.syncCell, values: [['']] });
    }
    if (file) for (let i = start; i < out.length; i++) out[i] = { file, ...out[i] };
  }
  return out;
}

/** 版式格式：红色标题条、灰色标签列、醒目的黄色输入格；金山不支持的属性会被脚本忽略 */
export function layoutFormats(unitFiles: Record<string, string> | null = null): KdocsFormat[] {
  const C = KDOCS_COLORS;
  const L = KDOCS_LAYOUT;
  const out: KdocsFormat[] = [];
  for (const u of UNITS) {
    const at = unitFiles?.[u.code] ? { file: unitFiles[u.code], sheet: u.name } : { sheet: u.name };
    const f = (range: string, x: Omit<KdocsFormat, 'sheet' | 'range' | 'file'>) => out.push({ ...at, range, ...x });
    for (const r of L.legacyRanges) f(r, { fill: null });
    f('A1', { colWidth: 12.5 });
    f('B1', { colWidth: 34 });
    f('A1:B1', { fill: C.red, fontColor: C.white, bold: true, fontSize: 18, vCenter: true, rowHeight: 36 });
    f('B1', { fontSize: 11, bold: false, hAlign: 'right', wrap: true });
    f(`A2:A${L.lastRow}`, { fill: C.labelFill, fontColor: C.label, fontSize: 12, vCenter: true });
    f(`B2:B${L.lastRow}`, { fontColor: C.text, fontSize: 14, bold: true, vCenter: true, wrap: true });
    f('A2:B5', { rowHeight: 26 });
    f('B4', { fontColor: C.red, fontSize: 18 });
    f('B5', { fontColor: C.gold });
    f(`A${L.inputRow}`, { fontColor: C.red, bold: true, fontSize: 14 });
    f(L.inputCell, { fill: C.inputFill, fontColor: C.red, fontSize: 22, bold: true, hAlign: 'center' });
    f(`A${L.inputRow}:B${L.inputRow}`, { rowHeight: 44 });
    f(L.resultCell, { fontSize: 13, rowHeight: 40 });
    f(L.noteCell, { fontSize: 11, bold: false, fontColor: C.label, rowHeight: 48 });
    f(L.syncCell, { fontSize: 11, bold: false, fontColor: C.muted });
  }
  return out;
}

function blankGrid(range: string): string[][] {
  const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(range)!;
  const cols = m[3].charCodeAt(0) - m[1].charCodeAt(0) + 1;
  const rows = Number(m[4]) - Number(m[2]) + 1;
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
}

export async function initKdocsLayout(d: KdocsDeps, eventId: string, actor: Actor, body: { clearInputs?: unknown }) {
  if (d.ctx.config.readOnly) throw bizError('READ_ONLY');
  const b = await requireBinding(d, eventId);
  const clearInputs = body.clearInputs === true;
  if (clearInputs && b.enabled) throw bizError('INVALID_STATE', '清空填写区前请先停止同步，避免误删现场填写');
  const ev = await getEventRow(d.ctx.db, eventId);
  const title = String((ev.config as { name?: string }).name || '理财、基金现场竞标');
  try {
    const r = await callScript(
      b.webhook_url,
      b.token,
      { action: 'batch', writes: layoutWrites(clearInputs, title, b.unit_files), formats: layoutFormats(b.unit_files) },
      d.sync.callOpts,
    );
    if (!isCurrentScript(r)) throw new KdocsError(OLD_SCRIPT_MESSAGE, 'PROTOCOL');
    d.sync.resetWritten(eventId);
    await withTx(d.ctx.db, (tx) => audit(tx, eventId, actor, 'KDOCS_LAYOUT', { details: { clearInputs, written: r.written ?? 0 } }));
    return {
      ok: true,
      written: r.written ?? 0,
      formatted: r.formatted ?? 0,
      formatErrors: r.formatErrors ?? [],
      missingUnits: UNITS.filter((u) => (r.missingSheets ?? []).includes(u.name) || (r.errors ?? []).some((x) => x.startsWith(`${u.name}：`))).map((u) => u.name),
      errors: r.errors ?? [],
    };
  } catch (e) {
    kdocsBizError(e);
  }
}

/**
 * 改用本机模拟金山文档并写好版式（不开启同步）。
 * mode='files'（默认，推荐）：一个「总控」文件放脚本，16 家单位各一个文件；mode='single'：一个文件 16 张工作表。
 */
export async function useKdocsMock(d: KdocsDeps, eventId: string, actor: Actor, localPort: number, mode: unknown = 'files') {
  if (!d.mock) throw bizError('FORBIDDEN', '本程序未启用模拟金山文档');
  if (!(await getEventRow(d.ctx.db, eventId)).is_demo) throw bizError('DEMO_ONLY', MOCK_DEMO_ONLY);
  const existing = await d.sync.binding(eventId);
  if (existing?.enabled) throw bizError('INVALID_STATE', '请先停止同步，再切换到模拟金山文档');
  // 模拟文件编号随机生成：拿不到链接就无法打开或填写（与金山文件分享链接同理）
  const base = `mock${randomBytes(10).toString('hex')}`;
  const single = mode === 'single';
  const hubId = single ? base : `${base}hub`;
  if (!d.mock.file(hubId)) d.mock.createFile(hubId, single ? UNITS : []);
  let unitFiles: string | null = null;
  if (!single) {
    for (const u of UNITS) {
      const id = `${base}-${u.code}`;
      if (!d.mock.file(id)) d.mock.createFile(id, [u]);
    }
    unitFiles = UNITS.map((u) => `${u.name} mock://${base}-${u.code}`).join('\n');
  }
  const webhookUrl = `http://127.0.0.1:${localPort}/mock-kdocs/api/v3/ide/file/${hubId}/script/bidsync/sync_task`;
  await saveKdocsBinding(d, eventId, actor, { webhookUrl, token: d.mock.token, enabled: false, unitFiles });
  await initKdocsLayout(d, eventId, actor, { clearInputs: false });
  return { ...(await getKdocsOverview(d, eventId)), mockFileId: hubId };
}

/**
 * 领导扫码填报卡：每家单位一张，二维码即本单位金山文件的链接（微信扫一扫直接打开本单位的表）。
 * 只适用于「每家单位一个文件」；模拟金山文档时二维码指向本机的模拟填写页。
 */
export async function kdocsCards(d: KdocsDeps, eventId: string) {
  const b = await requireBinding(d, eventId);
  if (!b.unit_files) throw bizError('BAD_REQUEST', '扫码填报卡只适用于「每家单位一个文件」：一个文件 16 张工作表时，各单位扫同一个码会看到全部单位');
  const ev = await getEventRow(d.ctx.db, eventId);
  const cfg = readConfig(ev);
  const cards = [];
  for (const u of UNITS) {
    const raw = b.unit_files[u.code];
    if (!raw) continue;
    const mock = /^mock:\/\/([A-Za-z0-9_-]+)$/.exec(raw);
    const url = mock ? `${d.ctx.config.publicBaseUrl}/mock-kdocs?file=${mock[1]}` : raw;
    cards.push({ unitCode: u.code, unitName: u.name, url, qrDataUrl: await qrDataUrl(url) });
  }
  return { eventName: cfg.name, wifi: await wifiInfo(cfg), isMock: isMockUrl(b.webhook_url), cards };
}
