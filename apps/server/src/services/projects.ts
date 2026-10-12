/**
 * 项目状态机与现场控制：首轮发布冻结、开始/暂停/恢复、组别开闭、锁定结果快照、底标确认。
 * DRAFT → ROUND1_PUBLISHED → LIVE ↔ PAUSED → LOCKED；锁定只允许从暂停执行，不可退回。
 */

import {
  GROUP_BY_NO,
  type GroupNo,
  PROJECT_NAMES,
  type ProjectCode,
  type ProjectStatus,
  PROJECT_CODES,
  UNITS,
  UNIT_BY_CODE,
  canTransition,
  checkGroupMinimum,
  checkIncreasePpFormat,
  fenToWanExact,
  lockedLeaderLabel,
  rankGroup,
  targetFen,
} from '@bidding/shared';
import type { Tx } from '../db/pool';
import { uuid } from '../lib/crypto';
import { bizError } from '../lib/errors';
import { shanghaiDateCompact } from '../lib/time';
import { type Actor, type EventRow, audit, emit } from './core';
import { type AppContext, runWrite } from './context';
import { configProblems, readConfig } from './events';

export interface ProjectRow {
  event_id: string;
  project_code: ProjectCode;
  status: ProjectStatus;
  draft_version: number;
  control_version: number;
  current_group: GroupNo | null;
  first_round_snapshot_id: string | null;
  result_snapshot_id: string | null;
  published_at: Date | null;
  started_at: Date | null;
  locked_at: Date | null;
}

export interface GroupRow {
  group_no: GroupNo;
  min_increase_pp: number;
  status: 'WAITING' | 'OPEN' | 'CLOSED';
}

export function parseProject(p: unknown): ProjectCode {
  if (p !== 'wealth' && p !== 'fund') throw bizError('NOT_FOUND', '项目不存在');
  return p;
}

export function parseUnit(u: unknown): string {
  if (typeof u !== 'string' || !UNIT_BY_CODE.has(u)) throw bizError('NOT_FOUND', '单位不存在');
  return u;
}

export async function lockProject(tx: Tx, eventId: string, projectCode: ProjectCode): Promise<ProjectRow> {
  const r = await tx.query<ProjectRow>(
    'SELECT * FROM projects WHERE event_id = $1 AND project_code = $2 FOR UPDATE',
    [eventId, projectCode],
  );
  if (!r.rowCount) throw bizError('NOT_FOUND', '项目不存在');
  return r.rows[0];
}

export async function loadGroups(tx: Tx, eventId: string, projectCode: ProjectCode): Promise<GroupRow[]> {
  const r = await tx.query<GroupRow>(
    'SELECT group_no, min_increase_pp, status FROM project_groups WHERE event_id = $1 AND project_code = $2 ORDER BY group_no',
    [eventId, projectCode],
  );
  return r.rows;
}

/** 发布前检查：16 家底标与首轮完整有效 */
export async function firstRoundProblems(tx: Tx, eventId: string, projectCode: ProjectCode): Promise<string[]> {
  const r = await tx.query<{ unit_code: string; base_target_fen: string | null; first_round_pp: number | null }>(
    'SELECT unit_code, base_target_fen, first_round_pp FROM first_round_drafts WHERE event_id = $1 AND project_code = $2',
    [eventId, projectCode],
  );
  const problems: string[] = [];
  const byUnit = new Map(r.rows.map((d) => [d.unit_code, d]));
  for (const u of UNITS) {
    const d = byUnit.get(u.code);
    if (!d || d.base_target_fen === null) problems.push(`${u.name}：基础底标待录入`);
    if (!d || d.first_round_pp === null) {
      problems.push(`${u.name}：首轮增幅待录入`);
      continue;
    }
    const fmt = checkIncreasePpFormat(d.first_round_pp, '首轮增幅');
    if (!fmt.ok) problems.push(`${u.name}：${fmt.reason}`);
    const g = GROUP_BY_NO.get(u.groupNo)!;
    const min = checkGroupMinimum(d.first_round_pp, g.minIncreasePp, g.name);
    if (!min.ok) problems.push(`${u.name}：${min.reason}`);
  }
  return problems;
}

function checkControlVersion(project: ProjectRow, expected: unknown): void {
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    throw bizError('BAD_REQUEST', 'expectedControlVersion 须为整数');
  }
  if (expected !== project.control_version) {
    throw bizError('CONTROL_VERSION_CONFLICT', undefined, { currentControlVersion: project.control_version, status: project.status });
  }
}

async function bumpControl(tx: Tx, eventId: string, projectCode: ProjectCode, set: string, params: unknown[] = []): Promise<ProjectRow> {
  const r = await tx.query<ProjectRow>(
    `UPDATE projects SET control_version = control_version + 1${set ? ', ' + set : ''}
      WHERE event_id = $1 AND project_code = $2 RETURNING *`,
    [eventId, projectCode, ...params],
  );
  return r.rows[0];
}

/** 先理财后基金：基金开始竞标要求理财已锁定 */
async function assertProjectOrder(tx: Tx, eventId: string, projectCode: ProjectCode): Promise<void> {
  if (projectCode !== 'fund') return;
  const w = await tx.query<{ status: string }>(
    `SELECT status FROM projects WHERE event_id = $1 AND project_code = 'wealth'`,
    [eventId],
  );
  if (w.rows[0]?.status !== 'LOCKED') throw bizError('PROJECT_ORDER');
}

// ---------------------------------------------------------------- 首轮发布（会前准备：理财、基金一起冻结）

/** 在事务内冻结一个项目的首轮：写不可变快照、初始化当前竞标状态 */
async function freezeOne(tx: Tx, ev: EventRow, actor: Actor, projectCode: ProjectCode, expectedDraftVersion: unknown) {
  const eventId = ev.id;
  const project = await lockProject(tx, eventId, projectCode);
  if (project.status !== 'DRAFT') throw bizError('INVALID_STATE', `${PROJECT_NAMES[projectCode]}首轮已发布`);
  if (expectedDraftVersion !== undefined && expectedDraftVersion !== project.draft_version) {
    throw bizError('DRAFT_VERSION_CONFLICT', '草稿已被修改，请刷新核对后再发布', { currentDraftVersion: project.draft_version });
  }
  const problems = await firstRoundProblems(tx, eventId, projectCode);
  if (problems.length) {
    throw bizError('ROUND1_INCOMPLETE', `${PROJECT_NAMES[projectCode]}首轮数据不完整或无效（${problems.length} 项）`, {
      problems: problems.map((x) => `${PROJECT_NAMES[projectCode]}：${x}`),
    });
  }
  const snapshotId = uuid();
  const now = new Date();
  const batchNo = `${projectCode === 'wealth' ? 'LC' : 'JJ'}-R1-${shanghaiDateCompact(now)}`;
  await tx.query(
    `INSERT INTO first_round_snapshots (id, event_id, project_code, batch_no, draft_version, published_at, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [snapshotId, eventId, projectCode, batchNo, project.draft_version, now, actor.id],
  );
  await tx.query(
    `INSERT INTO first_round_snapshot_rows (snapshot_id, unit_code, base_target_fen, first_round_pp, remark)
     SELECT $1, unit_code, base_target_fen, first_round_pp, remark
       FROM first_round_drafts WHERE event_id = $2 AND project_code = $3`,
    [snapshotId, eventId, projectCode],
  );
  // 当前增幅从首轮快照起算
  await tx.query(
    `INSERT INTO bid_states (event_id, project_code, unit_code, base_target_fen, first_round_pp, current_pp)
     SELECT $1, $2, unit_code, base_target_fen, first_round_pp, first_round_pp
       FROM first_round_snapshot_rows WHERE snapshot_id = $3`,
    [eventId, projectCode, snapshotId],
  );
  await bumpControl(tx, eventId, projectCode, `status = 'ROUND1_PUBLISHED', published_at = $3, first_round_snapshot_id = $4`, [now, snapshotId]);
  const seq = await emit(tx, eventId, {
    type: 'FIRST_ROUND_PUBLISHED',
    audience: 'PUBLIC',
    projectCode,
    data: { snapshotId, batchNo, publishedAt: now.toISOString() },
  });
  await audit(tx, eventId, actor, 'FIRST_ROUND_PUBLISHED', {
    projectCode,
    details: { snapshotId, batchNo, draftVersion: project.draft_version },
    eventSequence: seq,
  });
  return { snapshotId, batchNo, publishedAt: now.toISOString(), projectCode, status: 'ROUND1_PUBLISHED' as const };
}

/** 冻结后当前专场与大屏：理财未锁定时为理财，否则为基金 */
async function pointScreenAfterFreeze(tx: Tx, eventId: string): Promise<void> {
  const w = await tx.query<{ status: string }>(`SELECT status FROM projects WHERE event_id = $1 AND project_code = 'wealth'`, [eventId]);
  const current: ProjectCode = w.rows[0]?.status === 'LOCKED' ? 'fund' : 'wealth';
  const ev = await tx.query<{ current_project: string; screen_mode: string; screen_project: string }>(
    'SELECT current_project, screen_mode, screen_project FROM events WHERE id = $1',
    [eventId],
  );
  const e = ev.rows[0];
  if (e.current_project === current && e.screen_mode === 'FIRST_ROUND' && e.screen_project === current) return;
  await tx.query(`UPDATE events SET current_project = $2, screen_mode = 'FIRST_ROUND', screen_project = $2 WHERE id = $1`, [eventId, current]);
  await emit(tx, eventId, { type: 'SCREEN_MODE', audience: 'PUBLIC', projectCode: current, data: { mode: 'FIRST_ROUND', projectCode: current } });
}

function checkFreezeAllowed(ev: EventRow): void {
  const cfgProblems = ev.is_demo ? [] : configProblems(readConfig(ev));
  if (cfgProblems.length) throw bizError('CONFIG_INCOMPLETE', `活动配置不完整：${cfgProblems.join('、')}`, { problems: cfgProblems });
}

/** 单个项目发布首轮（保留接口；基金不再要求理财先锁定） */
export async function publishFirstRound(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  projectCodeRaw: unknown,
  input: { expectedDraftVersion?: unknown; idempotencyKey?: unknown; confirm?: unknown },
) {
  const projectCode = parseProject(projectCodeRaw);
  if (input.confirm !== true) throw bizError('CONFIRM_REQUIRED', '首轮发布后底标与首轮值将冻结，不可修改，请二次确认');
  if (typeof input.expectedDraftVersion !== 'number') throw bizError('BAD_REQUEST', 'expectedDraftVersion 须为整数');
  const result = await runWrite(
    ctx,
    eventId,
    actor,
    {
      operation: 'PUBLISH_FIRST_ROUND',
      idempotencyKey: input.idempotencyKey,
      request: { projectCode, expectedDraftVersion: input.expectedDraftVersion },
    },
    async (tx, ev) => {
      checkFreezeAllowed(ev);
      const body = await freezeOne(tx, ev, actor, projectCode, input.expectedDraftVersion);
      await pointScreenAfterFreeze(tx, eventId);
      return { body };
    },
  );
  if (!result.replayed) ctx.onCheckpoint?.(eventId, `${projectCode}-首轮发布`);
  return result;
}

/** 会前准备：理财、基金首轮一起冻结（任一项目不完整则都不冻结） */
export async function publishFirstRoundAll(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  input: { expectedDraftVersion?: unknown; idempotencyKey?: unknown; confirm?: unknown },
) {
  if (input.confirm !== true) throw bizError('CONFIRM_REQUIRED', '冻结后理财、基金的底标与首轮值都不可修改，请二次确认');
  if (typeof input.expectedDraftVersion !== 'number') throw bizError('BAD_REQUEST', 'expectedDraftVersion 须为整数');
  const result = await runWrite(
    ctx,
    eventId,
    actor,
    {
      operation: 'PUBLISH_FIRST_ROUND_ALL',
      idempotencyKey: input.idempotencyKey,
      request: { expectedDraftVersion: input.expectedDraftVersion },
    },
    async (tx, ev) => {
      if (ev.draft_version !== input.expectedDraftVersion) {
        throw bizError('DRAFT_VERSION_CONFLICT', '首轮草稿已被修改，请刷新核对后再冻结', { currentDraftVersion: ev.draft_version });
      }
      checkFreezeAllowed(ev);
      const statuses = await tx.query<{ project_code: ProjectCode; status: string }>('SELECT project_code, status FROM projects WHERE event_id = $1', [eventId]);
      const drafts = statuses.rows.filter((r) => r.status === 'DRAFT').map((r) => r.project_code);
      if (!drafts.length) throw bizError('INVALID_STATE', '理财、基金首轮均已冻结');
      // 先整体检查两项，避免只冻结了一半
      const problems: string[] = [];
      for (const p of PROJECT_CODES.filter((c) => drafts.includes(c))) {
        problems.push(...(await firstRoundProblems(tx, eventId, p)).map((x) => `${PROJECT_NAMES[p]}：${x}`));
      }
      if (problems.length) throw bizError('ROUND1_INCOMPLETE', `首轮数据不完整或无效（${problems.length} 项）`, { problems });
      const published = [];
      for (const p of PROJECT_CODES.filter((c) => drafts.includes(c))) published.push(await freezeOne(tx, ev, actor, p, undefined));
      await pointScreenAfterFreeze(tx, eventId);
      return { body: { published } };
    },
  );
  if (!result.replayed) ctx.onCheckpoint?.(eventId, '首轮冻结');
  return result;
}

// ---------------------------------------------------------------- 现场控制

export type ControlAction = 'START' | 'PAUSE' | 'RESUME' | 'OPEN_GROUP' | 'CLOSE_GROUP' | 'LOCK';

export interface ControlInput {
  action?: unknown;
  groupNo?: unknown;
  reason?: unknown;
  confirm?: unknown;
  /** 提前收场：有分组未结束时锁定，须单独勾选确认 */
  earlyLock?: unknown;
  expectedControlVersion?: unknown;
  idempotencyKey?: unknown;
}

export async function controlProject(ctx: AppContext, eventId: string, actor: Actor, projectCodeRaw: unknown, input: ControlInput) {
  const projectCode = parseProject(projectCodeRaw);
  const action = input.action as ControlAction;
  if (!['START', 'PAUSE', 'RESUME', 'OPEN_GROUP', 'CLOSE_GROUP', 'LOCK'].includes(action)) {
    throw bizError('BAD_REQUEST', '未知控制动作');
  }
  const groupNo = input.groupNo === undefined || input.groupNo === null ? null : Number(input.groupNo);
  if (groupNo !== null && ![1, 2, 3].includes(groupNo)) throw bizError('BAD_REQUEST', '组别不合法');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (action === 'LOCK' && input.confirm !== true) {
    throw bizError('CONFIRM_REQUIRED', '锁定后结果不可修改，请二次确认');
  }

  const result = await runWrite<Record<string, unknown>>(
    ctx,
    eventId,
    actor,
    {
      operation: `CONTROL_${action}`,
      idempotencyKey: input.idempotencyKey,
      request: { projectCode, action, groupNo, reason, expectedControlVersion: input.expectedControlVersion },
    },
    async (tx, ev) => {
      const project = await lockProject(tx, eventId, projectCode);
      checkControlVersion(project, input.expectedControlVersion);
      const groups = await loadGroups(tx, eventId, projectCode);
      switch (action) {
        case 'START':
          return { body: await start(tx, ev, actor, project, groups, groupNo) };
        case 'PAUSE':
          return { body: await setStatus(tx, eventId, actor, project, 'PAUSED', 'PROJECT_PAUSED', reason) };
        case 'RESUME':
          return { body: await setStatus(tx, eventId, actor, project, 'LIVE', 'PROJECT_RESUMED', reason) };
        case 'OPEN_GROUP':
          if (groupNo === null) throw bizError('BAD_REQUEST', '请选择要开放的组别');
          return { body: await openGroup(tx, eventId, actor, project, groups, groupNo as GroupNo, reason) };
        case 'CLOSE_GROUP':
          return { body: await closeGroup(tx, eventId, actor, project, groups, groupNo as GroupNo | null) };
        case 'LOCK':
          return { body: await lock(tx, eventId, actor, project, groups, { early: input.earlyLock === true, reason }) };
      }
    },
  );
  if (action === 'LOCK' && !result.replayed) ctx.onCheckpoint?.(eventId, `${projectCode}-项目锁定`);
  return result;
}

async function start(tx: Tx, ev: EventRow, actor: Actor, project: ProjectRow, groups: GroupRow[], groupNo: number | null) {
  const eventId = ev.id;
  if (project.status === 'DRAFT') throw bizError('INVALID_STATE', '请先发布完整有效的首轮数据');
  if (project.status !== 'ROUND1_PUBLISHED') {
    throw bizError('INVALID_STATE', `当前状态「${project.status}」不能开始竞标`);
  }
  await assertProjectOrder(tx, eventId, project.project_code);
  const problems = ev.is_demo ? [] : configProblems(readConfig(ev));
  if (problems.length) throw bizError('CONFIG_INCOMPLETE', `活动配置不完整：${problems.join('、')}`, { problems });
  const now = new Date();
  let updated = await bumpControl(tx, eventId, project.project_code, `status = 'LIVE', started_at = $3`, [now]);
  // 开始即成为当前专场（基金在理财锁定后开始）
  await tx.query(`UPDATE events SET current_project = $2, screen_mode = 'LIVE', screen_project = $2 WHERE id = $1`, [eventId, project.project_code]);
  const seq = await emit(tx, eventId, {
    type: 'PROJECT_STATUS',
    audience: 'PUBLIC',
    projectCode: project.project_code,
    data: { status: 'LIVE', controlVersion: updated.control_version },
  });
  await emit(tx, eventId, { type: 'SCREEN_MODE', audience: 'PUBLIC', projectCode: project.project_code, data: { mode: 'LIVE', projectCode: project.project_code } });
  await audit(tx, eventId, actor, 'PROJECT_STARTED', { projectCode: project.project_code, eventSequence: seq });
  if (groupNo !== null) {
    await openGroup(tx, eventId, actor, updated, groups, groupNo as GroupNo, '');
    updated = (await tx.query<ProjectRow>('SELECT * FROM projects WHERE event_id = $1 AND project_code = $2', [eventId, project.project_code])).rows[0];
  }
  return { status: updated.status, controlVersion: updated.control_version, currentGroup: updated.current_group };
}

async function setStatus(
  tx: Tx,
  eventId: string,
  actor: Actor,
  project: ProjectRow,
  to: 'LIVE' | 'PAUSED',
  auditAction: string,
  reason: string,
) {
  if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED');
  if (!canTransition(project.status, to)) {
    throw bizError('INVALID_STATE', to === 'PAUSED' ? '只有竞标中的项目可以暂停' : '只有已暂停的项目可以恢复');
  }
  const updated = await bumpControl(tx, eventId, project.project_code, 'status = $3', [to]);
  const seq = await emit(tx, eventId, {
    type: 'PROJECT_STATUS',
    audience: 'PUBLIC',
    projectCode: project.project_code,
    data: { status: to, controlVersion: updated.control_version },
  });
  await audit(tx, eventId, actor, auditAction, { projectCode: project.project_code, reason: reason || null, eventSequence: seq });
  return { status: updated.status, controlVersion: updated.control_version, currentGroup: updated.current_group };
}

async function openGroup(tx: Tx, eventId: string, actor: Actor, project: ProjectRow, groups: GroupRow[], groupNo: GroupNo, reason: string) {
  if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED');
  if (project.status !== 'LIVE' && project.status !== 'PAUSED') throw bizError('INVALID_STATE', '请先开始本项目竞标');
  const open = groups.find((g) => g.status === 'OPEN');
  if (open) throw bizError('INVALID_STATE', `第${open.group_no}组仍在进行，请先结束该组`);
  const target = groups.find((g) => g.group_no === groupNo)!;
  const reopen = target.status === 'CLOSED';
  await tx.query(
    `UPDATE project_groups SET status = 'OPEN', opened_at = now() WHERE event_id = $1 AND project_code = $2 AND group_no = $3`,
    [eventId, project.project_code, groupNo],
  );
  const updated = await bumpControl(tx, eventId, project.project_code, 'current_group = $3', [groupNo]);
  const seq = await emit(tx, eventId, {
    type: 'GROUP_STATUS',
    audience: 'PUBLIC',
    projectCode: project.project_code,
    data: { groupNo, status: 'OPEN', reopen, controlVersion: updated.control_version },
  });
  await audit(tx, eventId, actor, reopen ? 'GROUP_REOPENED' : 'GROUP_OPENED', {
    projectCode: project.project_code,
    reason: reason || null,
    details: { groupNo },
    eventSequence: seq,
  });
  return { status: updated.status, controlVersion: updated.control_version, currentGroup: updated.current_group };
}

async function closeGroup(tx: Tx, eventId: string, actor: Actor, project: ProjectRow, groups: GroupRow[], groupNo: GroupNo | null) {
  if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED');
  const open = groups.find((g) => g.status === 'OPEN');
  if (!open) throw bizError('INVALID_STATE', '当前没有进行中的组');
  if (groupNo !== null && open.group_no !== groupNo) throw bizError('INVALID_STATE', `进行中的是第${open.group_no}组`);
  // 服务端原子停止该组提交（与加码共享活动行锁）
  await tx.query(
    `UPDATE project_groups SET status = 'CLOSED', closed_at = now() WHERE event_id = $1 AND project_code = $2 AND group_no = $3`,
    [eventId, project.project_code, open.group_no],
  );
  let updated = await bumpControl(tx, eventId, project.project_code, '');
  const seq = await emit(tx, eventId, {
    type: 'GROUP_STATUS',
    audience: 'PUBLIC',
    projectCode: project.project_code,
    data: { groupNo: open.group_no, status: 'CLOSED', controlVersion: updated.control_version },
  });
  await audit(tx, eventId, actor, 'GROUP_CLOSED', { projectCode: project.project_code, details: { groupNo: open.group_no }, eventSequence: seq });
  // 结束最后一组自动暂停，便于核对与锁定
  const remainingWaiting = groups.filter((g) => g.group_no !== open.group_no && g.status === 'WAITING').length;
  if (remainingWaiting === 0 && updated.status === 'LIVE') {
    updated = await bumpControl(tx, eventId, project.project_code, `status = 'PAUSED'`);
    const s2 = await emit(tx, eventId, {
      type: 'PROJECT_STATUS',
      audience: 'PUBLIC',
      projectCode: project.project_code,
      data: { status: 'PAUSED', auto: true, controlVersion: updated.control_version },
    });
    await audit(tx, eventId, { type: 'SYSTEM', id: 'system', name: '系统' }, 'PROJECT_AUTO_PAUSED', {
      projectCode: project.project_code,
      reason: '最后一组结束自动暂停',
      eventSequence: s2,
    });
  }
  return { status: updated.status, controlVersion: updated.control_version, currentGroup: updated.current_group };
}

interface StateRow {
  unit_code: string;
  base_target_fen: string;
  first_round_pp: number;
  current_pp: number;
  version: number;
}

/** 由当前竞标状态计算各组排名（锁定快照和锁定预览共用） */
export function computeResults(states: StateRow[]) {
  const byUnit = new Map(states.map((s) => [s.unit_code, s]));
  const groups = ([1, 2, 3] as GroupNo[]).map((groupNo) => {
    const units = UNITS.filter((u) => u.groupNo === groupNo);
    const ranking = rankGroup(units.map((u) => ({ unitCode: u.code, displayOrder: u.displayOrder, increasePp: byUnit.get(u.code)?.current_pp ?? null })));
    return { groupNo, ranking };
  });
  // 只有达到标王门槛的并列第一才涉及授旗规则；未达门槛的并列仍保留并列名次
  const tieWarnings = groups
    .filter((g) => g.ranking.leaderStatus === 'TIED_PENDING')
    .map((g) => ({
      groupNo: g.groupNo,
      unitCodes: g.ranking.topUnitCodes,
      topPp: g.ranking.topPp,
      message: `第${g.groupNo}组并列第一（${g.ranking.topUnitCodes.map((c) => UNIT_BY_CODE.get(c)!.name).join('、')}，${g.ranking.topPp}%），授旗规则未确认`,
    }));
  return { groups, tieWarnings, byUnit };
}

export async function lockPreview(tx: Tx, eventId: string, projectCode: ProjectCode) {
  const unfinished = unfinishedGroups(await loadGroups(tx, eventId, projectCode));
  const s = await tx.query<StateRow>(
    'SELECT unit_code, base_target_fen, first_round_pp, current_pp, version FROM bid_states WHERE event_id = $1 AND project_code = $2',
    [eventId, projectCode],
  );
  const { groups, tieWarnings } = computeResults(s.rows);
  return {
    tieWarnings,
    unfinishedGroups: unfinished,
    groups: groups.map((g) => ({
      groupNo: g.groupNo,
      leaderStatus: g.ranking.leaderStatus,
      topPp: g.ranking.topPp,
      topUnitCodes: g.ranking.topUnitCodes,
    })),
  };
}

/** 尚未结束的分组（锁定前核对用） */
export function unfinishedGroups(groups: GroupRow[]) {
  return groups
    .filter((g) => g.status !== 'CLOSED')
    .map((g) => ({ groupNo: g.group_no, name: GROUP_BY_NO.get(g.group_no)!.name, status: g.status, statusText: g.status === 'OPEN' ? '进行中' : '未开始' }));
}

async function lock(tx: Tx, eventId: string, actor: Actor, project: ProjectRow, groupRows: GroupRow[], opts: { early: boolean; reason: string }) {
  if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED', '项目已锁定');
  if (project.status !== 'PAUSED') throw bizError('INVALID_STATE', '锁定前请先暂停竞标，核对后再锁定');
  // 正常锁定要求各组都已结束；提前收场须单独确认（勾选「提前收场」），单独记入审计
  const unfinished = unfinishedGroups(groupRows);
  if (unfinished.length) {
    const names = unfinished.map((g) => `${g.name}（${g.statusText}）`).join('、');
    if (!opts.early) {
      throw bizError('GROUPS_NOT_FINISHED', `${names}尚未结束。正常锁定要求各组都已结束；确需提前收场，请勾选「提前收场」确认`, { groups: unfinished });
    }
  }
  const states = await tx.query<StateRow>(
    'SELECT unit_code, base_target_fen, first_round_pp, current_pp, version FROM bid_states WHERE event_id = $1 AND project_code = $2',
    [eventId, project.project_code],
  );
  const { groups, tieWarnings, byUnit } = computeResults(states.rows);
  const now = new Date();
  await tx.query(
    `UPDATE project_groups SET status = 'CLOSED', closed_at = COALESCE(closed_at, now())
      WHERE event_id = $1 AND project_code = $2 AND status = 'OPEN'`,
    [eventId, project.project_code],
  );
  const updated = await bumpControl(tx, eventId, project.project_code, `status = 'LOCKED', locked_at = $3`, [now]);
  if (unfinished.length) {
    await audit(tx, eventId, actor, 'PROJECT_LOCKED_EARLY', {
      projectCode: project.project_code,
      reason: opts.reason || '工作人员确认提前收场',
      details: { unfinishedGroups: unfinished },
    });
  }
  const seq = await emit(tx, eventId, {
    type: 'PROJECT_LOCKED',
    audience: 'PUBLIC',
    projectCode: project.project_code,
    data: { lockedAt: now.toISOString(), tieWarnings, controlVersion: updated.control_version },
  });
  const snapshotId = uuid();
  await tx.query(
    `INSERT INTO result_snapshots (id, event_id, project_code, locked_at, locked_by, event_sequence, groups, tie_warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      snapshotId,
      eventId,
      project.project_code,
      now,
      actor.id,
      seq,
      JSON.stringify(groups.map((g) => ({ groupNo: g.groupNo, leaderStatus: g.ranking.leaderStatus, topPp: g.ranking.topPp, topUnitCodes: g.ranking.topUnitCodes }))),
      JSON.stringify(tieWarnings),
    ],
  );
  for (const g of groups) {
    for (const row of g.ranking.rows) {
      const s = byUnit.get(row.unitCode)!;
      const label = row.isTop ? lockedLeaderLabel(g.ranking.leaderStatus) : '';
      await tx.query(
        `INSERT INTO result_snapshot_rows (snapshot_id, unit_code, group_no, base_target_fen, first_round_pp, final_pp, target_fen, rank, is_top, leader_label, bid_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [snapshotId, row.unitCode, g.groupNo, s.base_target_fen, s.first_round_pp, s.current_pp, targetFen(BigInt(s.base_target_fen), s.current_pp).toString(), row.rank, row.isTop, label, s.version],
      );
    }
  }
  await tx.query('UPDATE projects SET result_snapshot_id = $3 WHERE event_id = $1 AND project_code = $2', [eventId, project.project_code, snapshotId]);
  // 理财锁定后，基金（已冻结首轮）成为当前专场：领导手机与金山表格转到基金；大屏仍停在理财，由工作人员切换
  if (project.project_code === 'wealth') {
    await tx.query(
      `UPDATE events SET current_project = 'fund' WHERE id = $1
          AND EXISTS (SELECT 1 FROM projects WHERE event_id = $1 AND project_code = 'fund' AND status = 'ROUND1_PUBLISHED')`,
      [eventId],
    );
  }
  await audit(tx, eventId, actor, 'PROJECT_LOCKED', {
    projectCode: project.project_code,
    details: { snapshotId, tieWarnings },
    eventSequence: seq,
  });
  return { status: 'LOCKED' as const, controlVersion: updated.control_version, snapshotId, lockedAt: now.toISOString(), tieWarnings };
}

// ---------------------------------------------------------------- 底标确认

export async function acknowledgeBase(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  projectCodeRaw: unknown,
  unitCode: string,
  input: { idempotencyKey?: unknown; reason?: unknown },
  /** 内部调用渠道（不来自请求体）：金山文档同步 */
  opts: { channel?: 'KDOCS' } = {},
) {
  const projectCode = parseProject(projectCodeRaw);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const proxy = actor.type === 'ADMIN';
  const source = opts.channel ?? (proxy ? 'ADMIN_PROXY' : 'LEADER');
  return runWrite(
    ctx,
    eventId,
    actor,
    {
      operation: 'BASE_ACK',
      idempotencyKey: input.idempotencyKey,
      request: { projectCode, unitCode, reason },
      storeFailures: true,
      failureLog: { projectCode, unitCode },
    },
    async (tx) => {
      const project = await lockProject(tx, eventId, projectCode);
      if (project.status === 'DRAFT') throw bizError('PROJECT_NOT_ACTIVE', '首轮发布后才能确认认领基础底标');
      if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED');
      const s = await tx.query(
        'SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2 AND unit_code = $3 FOR UPDATE',
        [eventId, projectCode, unitCode],
      );
      const state = s.rows[0];
      const baseTargetWan = fenToWanExact(BigInt(state.base_target_fen));
      if (state.base_ack_at) {
        return {
          body: {
            projectCode,
            unitCode,
            baseTargetWan,
            acknowledgedAt: state.base_ack_at.toISOString(),
            source: state.base_ack_source,
            alreadyAcknowledged: true,
          },
        };
      }
      const now = new Date();
      await tx.query(
        `UPDATE bid_states SET base_ack_at = $4, base_ack_source = $5, base_ack_actor = $6, base_ack_reason = $7, updated_at = now()
          WHERE event_id = $1 AND project_code = $2 AND unit_code = $3`,
        [eventId, projectCode, unitCode, now, source, actor.name, reason || null],
      );
      const seq = await emit(tx, eventId, {
        type: 'BASE_ACKNOWLEDGED',
        audience: 'UNIT',
        projectCode,
        unitCode,
        data: { acknowledgedAt: now.toISOString(), source },
      });
      await audit(tx, eventId, actor, proxy ? 'BASE_ACK_PROXY' : 'BASE_ACK', {
        projectCode,
        unitCode,
        reason: reason || null,
        details: { baseTargetWan },
        eventSequence: seq,
      });
      return {
        body: {
          projectCode,
          unitCode,
          baseTargetWan,
          acknowledgedAt: now.toISOString(),
          source,
          alreadyAcknowledged: false,
        },
      };
    },
  );
}
