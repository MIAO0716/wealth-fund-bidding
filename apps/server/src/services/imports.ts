/**
 * 首轮数据导入：JSON 接口、CSV/Excel 上传、管理端手动录入共用同一套服务端校验。
 * 校验 → 返回 validationId → 提交时重新核验并在一个事务内整批写入，任一行错误整批拒绝。
 */

import {
  type ImportRowInput,
  type ImportRowResult,
  type ImportValidationResult,
  PROJECT_CODES,
  type ProjectCode,
  UNIT_BY_CODE,
  UNITS,
  GROUP_BY_NO,
  checkGroupMinimum,
  checkIncreasePpFormat,
  fenToWanExact,
  parseProjectCode,
  parseWanToFen,
  targetFen,
} from '@bidding/shared';
import type { Queryable, Tx } from '../db/pool';
import { digest, uuid } from '../lib/crypto';
import { bizError } from '../lib/errors';
import { toIso } from '../lib/time';
import { type Actor, audit, emit, lockEvent } from './core';
import { type AppContext, runWrite } from './context';

export const VALIDATION_TTL_MS = 15 * 60 * 1000;
export const MAX_IMPORT_ROWS = 200;

export type ImportSource = 'JSON' | 'CSV' | 'XLSX' | 'MANUAL';

export interface SourcedRow extends ImportRowInput {
  /** 原文件行号 */
  sourceRow?: number;
}

interface NormalizedRow {
  projectCode: ProjectCode;
  unitCode: string;
  baseFen: bigint;
  pp: number;
  remark: string | null;
}

interface DraftRow {
  project_code: ProjectCode;
  unit_code: string;
  base_target_fen: string | null;
  first_round_pp: number | null;
  remark: string | null;
}

interface ProjectStateRow {
  project_code: ProjectCode;
  status: string;
}

async function loadDraftState(q: Queryable, eventId: string) {
  const drafts = await q.query<DraftRow>(
    'SELECT project_code, unit_code, base_target_fen, first_round_pp, remark FROM first_round_drafts WHERE event_id = $1',
    [eventId],
  );
  const projects = await q.query<ProjectStateRow>('SELECT project_code, status FROM projects WHERE event_id = $1', [eventId]);
  const draftMap = new Map(drafts.rows.map((d) => [`${d.project_code}:${d.unit_code}`, d]));
  const statusMap = new Map(projects.rows.map((p) => [p.project_code, p.status]));
  return { draftMap, statusMap };
}

/** 对一批行做完整校验（纯计算 + 当前草稿状态），不写库 */
export function validateRows(
  rows: SourcedRow[],
  state: { draftMap: Map<string, DraftRow>; statusMap: Map<string, string> },
): { results: ImportRowResult[]; normalized: (NormalizedRow | null)[] } {
  const results: ImportRowResult[] = [];
  const normalized: (NormalizedRow | null)[] = [];
  const seen = new Map<string, number[]>();

  rows.forEach((raw, index) => {
    const errors: string[] = [];
    const projectCode = parseProjectCode(raw.projectCode);
    if (raw.projectCode === undefined || raw.projectCode === null || raw.projectCode === '') errors.push('项目为必填项');
    else if (!projectCode) errors.push(`未知项目「${String(raw.projectCode)}」（应为 wealth/fund 或 理财/基金）`);

    const unitCodeRaw = typeof raw.unitCode === 'string' ? raw.unitCode.trim().toUpperCase() : raw.unitCode;
    const unit = typeof unitCodeRaw === 'string' ? UNIT_BY_CODE.get(unitCodeRaw) : undefined;
    if (unitCodeRaw === undefined || unitCodeRaw === null || unitCodeRaw === '') errors.push('单位代码为必填项');
    else if (!unit) errors.push(`未知单位代码「${String(unitCodeRaw)}」`);

    const unitName = typeof raw.unitName === 'string' ? raw.unitName.trim() : raw.unitName;
    if (unit && unitName !== undefined && unitName !== null && unitName !== '' && unitName !== unit.name) {
      errors.push(`单位名称「${String(unitName)}」与代码 ${unit.code}（${unit.name}）不一致`);
    }

    const base = parseWanToFen(raw.baseTargetWan);
    if (!base.ok) errors.push(base.reason);

    const ppCheck = checkIncreasePpFormat(raw.firstRoundIncreasePp, '首轮增幅');
    const pp = ppCheck.ok ? (raw.firstRoundIncreasePp as number) : null;
    if (!ppCheck.ok) errors.push(ppCheck.reason);
    if (pp !== null && unit) {
      const g = GROUP_BY_NO.get(unit.groupNo)!;
      const minCheck = checkGroupMinimum(pp, g.minIncreasePp, `${unit.name}所在${g.name}`);
      if (!minCheck.ok) errors.push(minCheck.reason);
    }

    let remark: string | null = null;
    if (raw.remark !== undefined && raw.remark !== null && raw.remark !== '') {
      if (typeof raw.remark !== 'string') errors.push('备注须为文本');
      else if (raw.remark.length > 200) errors.push('备注不能超过 200 字');
      else remark = raw.remark.trim() || null;
    }

    let previous: ImportRowResult['previous'] = null;
    let action: ImportRowResult['action'] = null;
    if (projectCode && unit) {
      const key = `${projectCode}:${unit.code}`;
      seen.set(key, [...(seen.get(key) ?? []), index]);
      const status = state.statusMap.get(projectCode);
      if (status && status !== 'DRAFT') errors.push(`${projectCode === 'wealth' ? '理财' : '基金'}首轮已发布并冻结，不能覆盖`);
      const d = state.draftMap.get(key);
      if (d) {
        previous = {
          baseTargetWan: d.base_target_fen ? fenToWanExact(BigInt(d.base_target_fen)) : null,
          firstRoundIncreasePp: d.first_round_pp,
        };
        if (base.ok && pp !== null) {
          const same =
            d.base_target_fen !== null &&
            BigInt(d.base_target_fen) === base.fen &&
            d.first_round_pp === pp &&
            (d.remark ?? null) === remark;
          action = d.base_target_fen === null && d.first_round_pp === null ? 'CREATE' : same ? 'UNCHANGED' : 'UPDATE';
        }
      }
    }

    results.push({
      index,
      sourceRow: raw.sourceRow ?? index + 1,
      status: errors.length ? 'ERROR' : 'OK',
      action: errors.length ? null : action,
      errors,
      projectCode,
      unitCode: unit?.code ?? (typeof unitCodeRaw === 'string' ? unitCodeRaw : null),
      unitName: unit?.name ?? null,
      baseTargetWan: base.ok ? fenToWanExact(base.fen) : typeof raw.baseTargetWan === 'string' ? raw.baseTargetWan : null,
      firstRoundIncreasePp: pp,
      previewTargetWan: base.ok && pp !== null ? fenToWanExact(targetFen(base.fen, pp)) : null,
      previous,
      remark,
    });
    normalized.push(
      errors.length || !projectCode || !unit || !base.ok || pp === null
        ? null
        : { projectCode, unitCode: unit.code, baseFen: base.fen, pp, remark },
    );
  });

  // 同一项目同一单位重复：所有重复行均报错
  for (const [key, idxs] of seen) {
    if (idxs.length < 2) continue;
    const [p, u] = key.split(':');
    for (const i of idxs) {
      const lines = idxs.filter((j) => j !== i).map((j) => results[j].sourceRow);
      results[i].errors.push(`${p === 'wealth' ? '理财' : '基金'} ${u} 重复出现（另见第 ${lines.join('、')} 行）`);
      results[i].status = 'ERROR';
      results[i].action = null;
      normalized[i] = null;
    }
  }
  return { results, normalized };
}

function completenessAfter(
  draftMap: Map<string, DraftRow>,
  normalized: (NormalizedRow | null)[],
): ImportValidationResult['completenessAfter'] {
  const filled = new Set<string>();
  for (const [key, d] of draftMap) if (d.base_target_fen !== null && d.first_round_pp !== null) filled.add(key);
  for (const n of normalized) if (n) filled.add(`${n.projectCode}:${n.unitCode}`);
  const out = {} as ImportValidationResult['completenessAfter'];
  for (const p of PROJECT_CODES) {
    out[p] = { complete: UNITS.filter((u) => filled.has(`${p}:${u.code}`)).length, total: UNITS.length };
  }
  return out;
}

function summarize(results: ImportRowResult[]): ImportValidationResult['summary'] {
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'OK').length,
    errors: results.filter((r) => r.status === 'ERROR').length,
    creates: results.filter((r) => r.action === 'CREATE').length,
    updates: results.filter((r) => r.action === 'UPDATE').length,
    unchanged: results.filter((r) => r.action === 'UNCHANGED').length,
  };
}

function rowsForHash(rows: SourcedRow[]) {
  return rows.map((r) => ({
    projectCode: r.projectCode ?? null,
    unitCode: r.unitCode ?? null,
    unitName: r.unitName ?? null,
    baseTargetWan: r.baseTargetWan ?? null,
    firstRoundIncreasePp: r.firstRoundIncreasePp ?? null,
    remark: r.remark ?? null,
  }));
}

function checkRowsShape(rows: unknown): SourcedRow[] {
  if (!Array.isArray(rows)) throw bizError('BAD_REQUEST', 'rows 须为数组');
  if (rows.length === 0) throw bizError('BAD_REQUEST', '没有可导入的数据行');
  if (rows.length > MAX_IMPORT_ROWS) throw bizError('BAD_REQUEST', `单批最多 ${MAX_IMPORT_ROWS} 行`);
  for (const r of rows) if (!r || typeof r !== 'object' || Array.isArray(r)) throw bizError('BAD_REQUEST', '每行须为对象');
  return rows as SourcedRow[];
}

/** 校验并保存导入预览；有效时返回短期 validationId */
export async function validateImport(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  input: { mode?: unknown; rows: unknown; source: ImportSource; fileName?: string | null; skippedBlank?: number },
): Promise<ImportValidationResult & { skippedBlank?: number }> {
  if (input.mode !== undefined && input.mode !== 'upsert') throw bizError('BAD_REQUEST', '目前仅支持 mode = "upsert"');
  if (ctx.config.readOnly) throw bizError('READ_ONLY');
  const rows = checkRowsShape(input.rows);
  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    const ev = await lockEvent(client, eventId);
    const state = await loadDraftState(client, eventId);
    const { results, normalized } = validateRows(rows, state);
    const summary = summarize(results);
    const valid = summary.errors === 0;
    const contentHash = digest({ mode: 'upsert', rows: rowsForHash(rows) });
    const id = uuid();
    const expiresAt = new Date(Date.now() + VALIDATION_TTL_MS);
    const result: ImportValidationResult = {
      validationId: valid ? id : null,
      valid,
      expiresAt: valid ? expiresAt.toISOString() : null,
      draftVersion: ev.draft_version,
      contentHash,
      rows: results,
      summary,
      completenessAfter: completenessAfter(state.draftMap, normalized),
    };
    await client.query(
      `INSERT INTO import_batches (id, event_id, source, file_name, status, content_hash, draft_version, rows, result, admin_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        eventId,
        input.source,
        input.fileName ?? null,
        valid ? 'VALIDATED' : 'INVALID',
        contentHash,
        ev.draft_version,
        JSON.stringify(rowsForHash(rows).map((r, i) => ({ ...r, sourceRow: rows[i].sourceRow ?? i + 1 }))),
        JSON.stringify({ summary, valid }),
        actor.id,
        expiresAt,
      ],
    );
    await client.query('COMMIT');
    return input.skippedBlank !== undefined ? { ...result, skippedBlank: input.skippedBlank } : result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 在事务内写入一批已校验通过的行，返回新草稿版本 */
async function applyRows(
  tx: Tx,
  eventId: string,
  actor: Actor,
  batchId: string,
  source: ImportSource,
  normalized: NormalizedRow[],
  results: ImportRowResult[],
): Promise<{ draftVersion: number; seq: number }> {
  const touched = new Set<ProjectCode>();
  for (const n of normalized) {
    await tx.query(
      `UPDATE first_round_drafts
          SET base_target_fen = $4, first_round_pp = $5, remark = $6, last_batch_id = $7, updated_at = now(), updated_by = $8
        WHERE event_id = $1 AND project_code = $2 AND unit_code = $3`,
      [eventId, n.projectCode, n.unitCode, n.baseFen.toString(), n.pp, n.remark, batchId, actor.id],
    );
    touched.add(n.projectCode);
  }
  for (const p of touched) {
    await tx.query('UPDATE projects SET draft_version = draft_version + 1 WHERE event_id = $1 AND project_code = $2', [eventId, p]);
  }
  const ev = await tx.query<{ draft_version: number }>(
    'UPDATE events SET draft_version = draft_version + 1 WHERE id = $1 RETURNING draft_version',
    [eventId],
  );
  const draftVersion = ev.rows[0].draft_version;
  const changes = results
    .filter((r) => r.action !== 'UNCHANGED')
    .map((r) => ({
      projectCode: r.projectCode,
      unitCode: r.unitCode,
      before: r.previous,
      after: { baseTargetWan: r.baseTargetWan, firstRoundIncreasePp: r.firstRoundIncreasePp, remark: r.remark },
    }));
  const seq = await emit(tx, eventId, {
    type: 'DRAFT_UPDATED',
    audience: 'ADMIN',
    data: { batchId, draftVersion, projects: [...touched], rows: normalized.length },
  });
  await audit(tx, eventId, actor, source === 'MANUAL' ? 'DRAFT_MANUAL_EDIT' : 'DRAFT_IMPORT_COMMIT', {
    projectCode: touched.size === 1 ? [...touched][0] : null,
    unitCode: normalized.length === 1 ? normalized[0].unitCode : null,
    details: { batchId, source, draftVersion, changes },
    eventSequence: seq,
  });
  return { draftVersion, seq };
}

export interface CommitResponse {
  batchId: string;
  committedAt: string;
  source: ImportSource;
  operator: string;
  draftVersion: number;
  rowCount: number;
  summary: ImportValidationResult['summary'];
}

export async function commitImport(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  input: { validationId?: unknown; expectedDraftVersion?: unknown; idempotencyKey?: unknown },
) {
  const { validationId, expectedDraftVersion } = input;
  if (typeof validationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(validationId)) {
    throw bizError('BAD_REQUEST', 'validationId 不合法');
  }
  if (typeof expectedDraftVersion !== 'number' || !Number.isInteger(expectedDraftVersion)) {
    throw bizError('BAD_REQUEST', 'expectedDraftVersion 须为整数');
  }
  return runWrite<CommitResponse>(
    ctx,
    eventId,
    actor,
    { operation: 'IMPORT_COMMIT', idempotencyKey: input.idempotencyKey, request: { validationId, expectedDraftVersion } },
    async (tx, ev) => {
      const b = await tx.query(
        'SELECT * FROM import_batches WHERE id = $1 AND event_id = $2 FOR UPDATE',
        [validationId, eventId],
      );
      if (!b.rowCount) throw bizError('NOT_FOUND', '校验记录不存在');
      const batch = b.rows[0];
      if (batch.admin_id !== actor.id) throw bizError('FORBIDDEN', '校验结果只能由发起校验的管理员提交');
      if (batch.status === 'COMMITTED') throw bizError('INVALID_STATE', '该批次已提交');
      if (batch.status !== 'VALIDATED') throw bizError('VALIDATION_FAILED', '该批次校验未通过，不能提交');
      if (new Date(batch.expires_at).getTime() < Date.now()) throw bizError('VALIDATION_EXPIRED');
      if (expectedDraftVersion !== ev.draft_version || batch.draft_version !== ev.draft_version) {
        throw bizError('DRAFT_VERSION_CONFLICT', '草稿在校验后已被修改，请重新校验', {
          currentDraftVersion: ev.draft_version,
        });
      }
      const rows = batch.rows as SourcedRow[];
      if (digest({ mode: 'upsert', rows: rowsForHash(rows) }) !== batch.content_hash) {
        throw bizError('VALIDATION_FAILED', '导入内容与校验摘要不一致');
      }
      // 提交时重新核验（项目状态等可能已变化）
      const state = await loadDraftState(tx, eventId);
      const { results, normalized } = validateRows(rows, state);
      if (results.some((r) => r.status === 'ERROR')) {
        throw bizError('VALIDATION_FAILED', '提交时重新校验未通过，整批未写入', { rows: results.filter((r) => r.status === 'ERROR') });
      }
      const { draftVersion } = await applyRows(tx, eventId, actor, batch.id, batch.source, normalized as NormalizedRow[], results);
      const committedAt = new Date();
      await tx.query(
        `UPDATE import_batches SET status = 'COMMITTED', committed_at = $2, committed_version = $3 WHERE id = $1`,
        [batch.id, committedAt, draftVersion],
      );
      return {
        body: {
          batchId: batch.id,
          committedAt: committedAt.toISOString(),
          source: batch.source,
          operator: actor.name,
          draftVersion,
          rowCount: normalized.length,
          summary: summarize(results),
        },
      };
    },
  );
}

/** 管理端手动录入单条草稿：同一套校验，校验与写入在一个事务内完成 */
export async function manualEdit(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  projectCode: string,
  unitCode: string,
  input: {
    baseTargetWan?: unknown;
    firstRoundIncreasePp?: unknown;
    remark?: unknown;
    expectedDraftVersion?: unknown;
    idempotencyKey?: unknown;
  },
) {
  const row: SourcedRow = {
    projectCode,
    unitCode,
    baseTargetWan: input.baseTargetWan,
    firstRoundIncreasePp: input.firstRoundIncreasePp,
    remark: input.remark,
    sourceRow: 1,
  };
  if (typeof input.expectedDraftVersion !== 'number') throw bizError('BAD_REQUEST', 'expectedDraftVersion 须为整数');
  return runWrite<CommitResponse>(
    ctx,
    eventId,
    actor,
    {
      operation: 'DRAFT_MANUAL_EDIT',
      idempotencyKey: input.idempotencyKey,
      request: { ...rowsForHash([row])[0], expectedDraftVersion: input.expectedDraftVersion },
    },
    async (tx, ev) => {
      if (input.expectedDraftVersion !== ev.draft_version) {
        throw bizError('DRAFT_VERSION_CONFLICT', '草稿已被修改，请刷新后再录入', { currentDraftVersion: ev.draft_version });
      }
      const state = await loadDraftState(tx, eventId);
      const { results, normalized } = validateRows([row], state);
      if (results[0].status === 'ERROR') {
        throw bizError('VALIDATION_FAILED', results[0].errors.join('；'), { rows: results });
      }
      const batchId = uuid();
      const contentHash = digest({ mode: 'upsert', rows: rowsForHash([row]) });
      const { draftVersion } = await applyRows(tx, eventId, actor, batchId, 'MANUAL', normalized as NormalizedRow[], results);
      const now = new Date();
      await tx.query(
        `INSERT INTO import_batches (id, event_id, source, status, content_hash, draft_version, rows, result, admin_id, expires_at, committed_at, committed_version)
         VALUES ($1, $2, 'MANUAL', 'COMMITTED', $3, $4, $5, $6, $7, $8, $8, $9)`,
        [batchId, eventId, contentHash, ev.draft_version, JSON.stringify(rowsForHash([row])), JSON.stringify({ summary: summarize(results), valid: true }), actor.id, now, draftVersion],
      );
      return {
        body: {
          batchId,
          committedAt: now.toISOString(),
          source: 'MANUAL' as const,
          operator: actor.name,
          draftVersion,
          rowCount: 1,
          summary: summarize(results),
        },
      };
    },
  );
}

export async function listBatches(q: Queryable, eventId: string) {
  const r = await q.query(
    `SELECT b.id, b.source, b.file_name, b.status, b.draft_version, b.committed_version, b.created_at, b.committed_at,
            b.result, a.display_name AS operator
       FROM import_batches b JOIN admins a ON a.id = b.admin_id
      WHERE b.event_id = $1 AND b.status = 'COMMITTED'
      ORDER BY b.committed_at DESC LIMIT 50`,
    [eventId],
  );
  return r.rows.map((b) => ({
    batchId: b.id,
    source: b.source,
    fileName: b.file_name,
    draftVersion: b.committed_version,
    committedAt: toIso(b.committed_at),
    operator: b.operator,
    summary: b.result.summary,
  }));
}
