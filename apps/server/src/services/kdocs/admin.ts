/**
 * 金山文档接入的管理操作：保存配置、测试连接、初始化表格版式、改用模拟金山文档、查看处理记录。
 */

import { KDOCS_LAYOUT, type KdocsWrite, UNITS, bidRowRange } from '@bidding/shared';
import { withTx } from '../../db/pool';
import { bizError } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { type Actor, audit } from '../core';
import type { AppContext } from '../context';
import { getEventRow } from '../events';
import { KdocsError, callScript, isMockUrl, normalizeWebhookUrl } from './client';
import type { KdocsMock } from './mock';
import type { KdocsBindingRow, KdocsSyncManager } from './sync';

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
    maxRows: b.max_rows,
    enabled: b.enabled,
    baselineDone: b.baseline_done,
    enabledAt: toIso(b.enabled_at),
    updatedAt: toIso(b.updated_at),
    isMock: isMockUrl(b.webhook_url),
  };
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
  body: { webhookUrl?: unknown; token?: unknown; intervalSec?: unknown; maxRows?: unknown; enabled?: unknown },
) {
  if (d.ctx.config.readOnly) throw bizError('READ_ONLY');
  await getEventRow(d.ctx.db, eventId);
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
  let token = existing?.token ?? '';
  if (typeof body.token === 'string' && body.token.trim()) token = body.token.trim();
  if (!token) throw bizError('BAD_REQUEST', '请填写脚本令牌');
  if (token.length > 500) throw bizError('BAD_REQUEST', '脚本令牌过长');
  const intervalSec = body.intervalSec === undefined ? (existing?.interval_sec ?? 3) : Number(body.intervalSec);
  if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > 60) throw bizError('BAD_REQUEST', '同步间隔须为 1–60 秒');
  const maxRows = body.maxRows === undefined ? (existing?.max_rows ?? KDOCS_LAYOUT.defaultBidRows) : Number(body.maxRows);
  if (!Number.isInteger(maxRows) || maxRows < 5 || maxRows > 200) throw bizError('BAD_REQUEST', '报价行数须为 5–200');
  const enabled = body.enabled === undefined ? (existing?.enabled ?? false) : body.enabled === true;
  // 换了表格：重新标记「开始同步前已填写」
  const docChanged = !existing || existing.webhook_url !== webhookUrl;

  await d.ctx.db.query(
    `INSERT INTO kdocs_bindings (event_id, webhook_url, token, interval_sec, max_rows, enabled, baseline_done, enabled_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, CASE WHEN $6 THEN now() END, now())
     ON CONFLICT (event_id) DO UPDATE SET
       webhook_url = EXCLUDED.webhook_url, token = EXCLUDED.token, interval_sec = EXCLUDED.interval_sec,
       max_rows = EXCLUDED.max_rows, enabled = EXCLUDED.enabled,
       baseline_done = CASE WHEN $7 THEN false ELSE kdocs_bindings.baseline_done END,
       enabled_at = CASE WHEN EXCLUDED.enabled AND NOT kdocs_bindings.enabled THEN now() ELSE kdocs_bindings.enabled_at END,
       updated_at = now()`,
    [eventId, webhookUrl, token, intervalSec, maxRows, enabled, docChanged],
  );
  if (!existing || existing.enabled !== enabled || docChanged) {
    await withTx(d.ctx.db, (tx) =>
      audit(tx, eventId, actor, enabled ? 'KDOCS_SYNC_ON' : 'KDOCS_SYNC_OFF', {
        details: { webhookUrl: isMockUrl(webhookUrl) ? '模拟金山文档' : webhookUrl.replace(/\/file\/[^/]+/, '/file/…'), intervalSec },
      }),
    );
  }
  if (d.mock && isMockUrl(webhookUrl)) {
    const fileId = /\/file\/([^/]+)\//.exec(webhookUrl)?.[1];
    const wb = fileId ? d.mock.file(fileId) : undefined;
    if (wb) wb.maxRows = maxRows;
  }
  await d.sync.refresh(eventId);
  return getKdocsOverview(d, eventId);
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

/** 测试连接：调用一次脚本，列出工作表，检查 16 家单位的工作表是否齐全 */
export async function testKdocs(d: KdocsDeps, eventId: string) {
  const b = await requireBinding(d, eventId);
  const started = Date.now();
  try {
    const r = await callScript(b.webhook_url, b.token, { action: 'ping' }, d.sync.callOpts);
    const sheets = r.sheets ?? [];
    return {
      ok: true,
      durationMs: Date.now() - started,
      sheets,
      missingUnits: UNITS.filter((u) => !sheets.includes(u.name)).map((u) => u.name),
    };
  } catch (e) {
    kdocsBizError(e);
  }
}

/** 版式写入指令：标题、信息区标签、表头、序号；clearInputs 时同时清空领导填写区与处理结果 */
export function layoutWrites(maxRows: number, clearInputs: boolean, title: string): KdocsWrite[] {
  const { first, last } = bidRowRange(maxRows);
  const out: KdocsWrite[] = [];
  for (const u of UNITS) {
    const s = u.name;
    out.push({ sheet: s, range: KDOCS_LAYOUT.titleCell, values: [[`${u.name} · ${title}`]] });
    out.push({ sheet: s, range: `A2:A${1 + KDOCS_LAYOUT.infoLabels.length}`, values: KDOCS_LAYOUT.infoLabels.map((l) => [l]) });
    out.push({ sheet: s, range: KDOCS_LAYOUT.syncLabelCell, values: [['最近同步']] });
    out.push({ sheet: s, range: `A${KDOCS_LAYOUT.ackRow}`, values: [[KDOCS_LAYOUT.ackLabel]] });
    out.push({ sheet: s, range: `A${KDOCS_LAYOUT.headerRow}:E${KDOCS_LAYOUT.headerRow}`, values: [[...KDOCS_LAYOUT.headers]] });
    out.push({ sheet: s, range: `A${first}:A${last}`, values: Array.from({ length: maxRows }, (_, i) => [i + 1]) });
    if (clearInputs) {
      out.push({ sheet: s, range: `B${KDOCS_LAYOUT.ackRow}:C${KDOCS_LAYOUT.ackRow}`, values: [['', '']] });
      out.push({ sheet: s, range: `B${first}:E${last}`, values: Array.from({ length: maxRows }, () => ['', '', '', '']) });
      out.push({ sheet: s, range: KDOCS_LAYOUT.infoValueRange, values: KDOCS_LAYOUT.infoLabels.map(() => ['']) });
    }
  }
  return out;
}

export async function initKdocsLayout(d: KdocsDeps, eventId: string, actor: Actor, body: { clearInputs?: unknown }) {
  if (d.ctx.config.readOnly) throw bizError('READ_ONLY');
  const b = await requireBinding(d, eventId);
  const clearInputs = body.clearInputs === true;
  if (clearInputs && b.enabled) throw bizError('INVALID_STATE', '清空填写区前请先停止同步，避免误删现场填写');
  const ev = await getEventRow(d.ctx.db, eventId);
  const title = String((ev.config as { name?: string }).name || '理财、基金现场竞标');
  try {
    const r = await callScript(b.webhook_url, b.token, { action: 'batch', writes: layoutWrites(b.max_rows, clearInputs, title) }, d.sync.callOpts);
    d.sync.resetWritten(eventId);
    await withTx(d.ctx.db, (tx) => audit(tx, eventId, actor, 'KDOCS_LAYOUT', { details: { clearInputs, written: r.written ?? 0 } }));
    return {
      ok: true,
      written: r.written ?? 0,
      missingUnits: UNITS.filter((u) => (r.missingSheets ?? []).includes(u.name)).map((u) => u.name),
      errors: r.errors ?? [],
    };
  } catch (e) {
    kdocsBizError(e);
  }
}

/** 改用本机模拟金山文档：新建模拟文件并写好版式（不开启同步） */
export async function useKdocsMock(d: KdocsDeps, eventId: string, actor: Actor, localPort: number) {
  if (!d.mock) throw bizError('FORBIDDEN', '本程序未启用模拟金山文档');
  const fileId = `mock${eventId.replace(/-/g, '').slice(0, 12)}`;
  if (!d.mock.file(fileId)) d.mock.createFile(fileId);
  const existing = await d.sync.binding(eventId);
  if (existing?.enabled) throw bizError('INVALID_STATE', '请先停止同步，再切换到模拟金山文档');
  const webhookUrl = `http://127.0.0.1:${localPort}/mock-kdocs/api/v3/ide/file/${fileId}/script/bidsync/sync_task`;
  await saveKdocsBinding(d, eventId, actor, { webhookUrl, token: d.mock.token, enabled: false });
  await initKdocsLayout(d, eventId, actor, { clearInputs: false });
  return { ...(await getKdocsOverview(d, eventId)), mockFileId: fileId };
}
