/**
 * 按权限裁剪的只读快照。每个快照都带活动序列号 seq，客户端随后订阅 seq 之后的实时事件。
 * - 大屏：只返回已发布数据；首轮未发布时不返回榜单。
 * - 领导：只返回本单位数据和当前专场信息。
 * - 管理员：完整数据（含草稿）。
 */

import {
  type BidFeedItem,
  type FirstRoundBoard,
  GROUPS,
  type GroupBoard,
  type GroupNo,
  type GroupView,
  type LiveRow,
  PROJECT_CODES,
  PROJECT_NAMES,
  type ProjectCode,
  type ProjectView,
  UNITS,
  UNIT_BY_CODE,
  fenToWanExact,
  rankGroup,
  targetFen,
} from '@bidding/shared';
import type { Tx } from '../db/pool';
import { toIso } from '../lib/time';
import { readConfig, toSummary } from './events';

async function loadProjects(tx: Tx, eventId: string): Promise<Record<ProjectCode, ProjectView>> {
  const p = await tx.query('SELECT * FROM projects WHERE event_id = $1', [eventId]);
  const g = await tx.query('SELECT * FROM project_groups WHERE event_id = $1 ORDER BY group_no', [eventId]);
  const out = {} as Record<ProjectCode, ProjectView>;
  for (const row of p.rows) {
    const groups: GroupView[] = g.rows
      .filter((x) => x.project_code === row.project_code)
      .map((x) => ({
        groupNo: x.group_no,
        name: GROUPS.find((gg) => gg.groupNo === x.group_no)!.name,
        minIncreasePp: x.min_increase_pp,
        status: x.status,
      }));
    out[row.project_code as ProjectCode] = {
      projectCode: row.project_code,
      name: PROJECT_NAMES[row.project_code as ProjectCode],
      status: row.status,
      draftVersion: row.draft_version,
      controlVersion: row.control_version,
      currentGroup: row.current_group,
      publishedAt: toIso(row.published_at),
      lockedAt: toIso(row.locked_at),
      groups,
    };
  }
  return out;
}

interface BidStateRow {
  unit_code: string;
  base_target_fen: string;
  first_round_pp: number;
  current_pp: number;
  version: number;
  base_ack_at: Date | null;
  base_ack_source: string | null;
}

async function loadStates(tx: Tx, eventId: string, projectCode: ProjectCode): Promise<Map<string, BidStateRow>> {
  const r = await tx.query<BidStateRow>(
    'SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2',
    [eventId, projectCode],
  );
  return new Map(r.rows.map((s) => [s.unit_code, s]));
}

export function buildBoards(project: ProjectView, states: Map<string, BidStateRow>, withAmounts: boolean): GroupBoard[] {
  return project.groups.map((g) => {
    const units = UNITS.filter((u) => u.groupNo === g.groupNo);
    const ranking = rankGroup(
      units.map((u) => ({ unitCode: u.code, displayOrder: u.displayOrder, increasePp: states.get(u.code)?.current_pp ?? null })),
    );
    const rows: LiveRow[] = ranking.rows
      .filter((r) => states.has(r.unitCode))
      .map((r) => {
        const s = states.get(r.unitCode)!;
        const u = UNIT_BY_CODE.get(r.unitCode)!;
        const row: LiveRow = {
          unitCode: u.code,
          unitName: u.name,
          groupNo: u.groupNo,
          displayOrder: u.displayOrder,
          firstRoundPp: s.first_round_pp,
          currentPp: s.current_pp,
          rank: r.rank,
          isTop: r.isTop,
          bidVersion: s.version,
          baseAcknowledged: !!s.base_ack_at,
        };
        if (withAmounts) {
          const base = BigInt(s.base_target_fen);
          row.baseTargetWan = fenToWanExact(base);
          row.targetWan = fenToWanExact(targetFen(base, s.current_pp));
        }
        return row;
      });
    return {
      groupNo: g.groupNo,
      name: g.name,
      minIncreasePp: g.minIncreasePp,
      status: g.status,
      leaderStatus: ranking.leaderStatus,
      topPp: ranking.topPp,
      topUnitCodes: ranking.topUnitCodes,
      rows,
    };
  });
}

async function recentBids(tx: Tx, eventId: string, projectCode: ProjectCode | null, limit: number): Promise<BidFeedItem[]> {
  const r = await tx.query(
    `SELECT * FROM bid_records WHERE event_id = $1 AND ($2::text IS NULL OR project_code = $2)
      ORDER BY event_sequence DESC LIMIT $3`,
    [eventId, projectCode, limit],
  );
  return r.rows.map((b) => ({
    bidId: b.id,
    receiptNo: b.receipt_no,
    unitCode: b.unit_code,
    unitName: UNIT_BY_CODE.get(b.unit_code)!.name,
    projectCode: b.project_code,
    fromPp: b.from_pp,
    toPp: b.to_pp,
    source: b.source,
    acceptedAt: b.accepted_at.toISOString(),
    eventSequence: Number(b.event_sequence),
  }));
}

function publicEvent(ev: ReturnType<typeof toSummary>) {
  return {
    id: ev.id,
    isDemo: ev.isDemo,
    name: ev.config.name,
    year: ev.config.year,
    eventDate: ev.config.eventDate,
    metricName: ev.config.metricName,
    amountBasis: ev.config.amountBasis,
    currentProject: ev.currentProject,
    screenMode: ev.screenMode,
    screenProject: ev.screenProject,
  };
}

// ---------------------------------------------------------------- 大屏

export async function screenLive(tx: Tx, eventId: string, projectCodeOpt?: ProjectCode) {
  const evRow = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const ev = toSummary(evRow);
  const projects = await loadProjects(tx, eventId);
  const projectCode = projectCodeOpt ?? ev.currentProject;
  const project = projects[projectCode];
  const published = project.status !== 'DRAFT';
  const states = published ? await loadStates(tx, eventId, projectCode) : new Map();
  return {
    seq: ev.seq,
    serverTime: new Date().toISOString(),
    event: publicEvent(ev),
    project,
    published,
    // 目标金额按「底标 ×（1 + 当前增幅）」实时计算（可在配置中关闭）
    groups: published ? buildBoards(project, states, readConfig(evRow).showAmountsOnScreen) : [],
    recentBids: published ? await recentBids(tx, eventId, projectCode, 5) : [],
  };
}

export async function firstRoundBoard(
  tx: Tx,
  eventId: string,
  projectCode: ProjectCode,
  opts: { includeDraft: boolean; withAmounts: boolean },
): Promise<FirstRoundBoard> {
  const project = (await tx.query('SELECT * FROM projects WHERE event_id = $1 AND project_code = $2', [eventId, projectCode])).rows[0];
  const published = project.status !== 'DRAFT';
  let rows: Array<{ unit_code: string; base_target_fen: string | null; first_round_pp: number | null; remark: string | null }> = [];
  let snapshotId: string | null = null;
  if (published) {
    snapshotId = project.first_round_snapshot_id;
    rows = (await tx.query('SELECT * FROM first_round_snapshot_rows WHERE snapshot_id = $1', [snapshotId])).rows;
  } else if (opts.includeDraft) {
    rows = (await tx.query('SELECT * FROM first_round_drafts WHERE event_id = $1 AND project_code = $2', [eventId, projectCode])).rows;
  }
  const byUnit = new Map(rows.map((r) => [r.unit_code, r]));
  const visible = published || opts.includeDraft;
  const groups = GROUPS.map((g) => {
    const units = UNITS.filter((u) => u.groupNo === g.groupNo);
    const complete = (code: string) => {
      const r = byUnit.get(code);
      return !!r && r.base_target_fen !== null && r.first_round_pp !== null;
    };
    const ranking = rankGroup(
      units.map((u) => ({ unitCode: u.code, displayOrder: u.displayOrder, increasePp: complete(u.code) ? byUnit.get(u.code)!.first_round_pp : null })),
    );
    return {
      groupNo: g.groupNo,
      name: g.name,
      minIncreasePp: g.minIncreasePp,
      rows: visible
        ? ranking.rows.map((r) => {
            const u = UNIT_BY_CODE.get(r.unitCode)!;
            const d = byUnit.get(r.unitCode);
            const base = d?.base_target_fen ? BigInt(d.base_target_fen) : null;
            return {
              unitCode: u.code,
              unitName: u.name,
              groupNo: u.groupNo,
              displayOrder: u.displayOrder,
              firstRoundPp: d?.first_round_pp ?? null,
              rank: r.rank,
              ...(opts.withAmounts
                ? {
                    baseTargetWan: base ? fenToWanExact(base) : null,
                    targetWan: base && d?.first_round_pp ? fenToWanExact(targetFen(base, d.first_round_pp)) : null,
                    remark: d?.remark ?? null,
                  }
                : {}),
            };
          })
        : [],
    };
  });
  const completeCount = UNITS.filter((u) => {
    const r = byUnit.get(u.code);
    return !!r && r.base_target_fen !== null && r.first_round_pp !== null;
  }).length;
  return {
    projectCode,
    published,
    publishedAt: toIso(project.published_at),
    snapshotId,
    completeCount: visible ? completeCount : 0,
    totalCount: UNITS.length,
    groups,
  };
}

export async function screenFirstRound(tx: Tx, eventId: string, projectCode: ProjectCode) {
  const evRow = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const ev = toSummary(evRow);
  const board = await firstRoundBoard(tx, eventId, projectCode, {
    includeDraft: false,
    withAmounts: readConfig(evRow).showAmountsOnScreen,
  });
  return { seq: ev.seq, serverTime: new Date().toISOString(), event: publicEvent(ev), board };
}

export async function resultBoards(tx: Tx, eventId: string, withAmounts: boolean) {
  const projects = await loadProjects(tx, eventId);
  const out: Record<string, unknown> = {};
  for (const p of PROJECT_CODES) {
    const project = projects[p];
    if (project.status !== 'LOCKED') {
      out[p] = { projectCode: p, name: PROJECT_NAMES[p], status: project.status, locked: false, groups: [] };
      continue;
    }
    const snap = (await tx.query('SELECT * FROM result_snapshots WHERE event_id = $1 AND project_code = $2', [eventId, p])).rows[0];
    const rows = (await tx.query('SELECT * FROM result_snapshot_rows WHERE snapshot_id = $1', [snap.id])).rows;
    const groups = (snap.groups as Array<{ groupNo: GroupNo; leaderStatus: string; topPp: number | null; topUnitCodes: string[] }>).map((g) => ({
      ...g,
      name: GROUPS.find((x) => x.groupNo === g.groupNo)!.name,
      minIncreasePp: GROUPS.find((x) => x.groupNo === g.groupNo)!.minIncreasePp,
      rows: rows
        .filter((r) => r.group_no === g.groupNo)
        .sort((a, b) => a.rank - b.rank || UNIT_BY_CODE.get(a.unit_code)!.displayOrder - UNIT_BY_CODE.get(b.unit_code)!.displayOrder)
        .map((r) => ({
          unitCode: r.unit_code,
          unitName: UNIT_BY_CODE.get(r.unit_code)!.name,
          firstRoundPp: r.first_round_pp,
          finalPp: r.final_pp,
          addedPp: r.final_pp - r.first_round_pp,
          rank: r.rank,
          isTop: r.is_top,
          leaderLabel: r.leader_label,
          ...(withAmounts ? { baseTargetWan: fenToWanExact(BigInt(r.base_target_fen)), targetWan: fenToWanExact(BigInt(r.target_fen)) } : {}),
        })),
    }));
    out[p] = {
      projectCode: p,
      name: PROJECT_NAMES[p],
      status: 'LOCKED',
      locked: true,
      lockedAt: toIso(snap.locked_at),
      snapshotId: snap.id,
      tieWarnings: snap.tie_warnings,
      groups,
    };
  }
  return out;
}

export async function screenResults(tx: Tx, eventId: string) {
  const evRow = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const ev = toSummary(evRow);
  return {
    seq: ev.seq,
    serverTime: new Date().toISOString(),
    event: publicEvent(ev),
    projects: await resultBoards(tx, eventId, readConfig(evRow).showAmountsOnScreen),
  };
}

// ---------------------------------------------------------------- 领导端

export async function bidderMe(tx: Tx, eventId: string, unitCode: string) {
  const evRow = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const ev = toSummary(evRow);
  const cfg = readConfig(evRow);
  const projects = await loadProjects(tx, eventId);
  const unit = UNIT_BY_CODE.get(unitCode)!;
  const perProject: Record<string, unknown> = {};
  for (const p of PROJECT_CODES) {
    const project = projects[p];
    const group = project.groups.find((g) => g.groupNo === unit.groupNo)!;
    let base: bigint | null = null;
    let firstRoundPp: number | null = null;
    let currentPp: number | null = null;
    let bidVersion: number | null = null;
    let ack: { at: string; source: string } | null = null;
    if (project.status === 'DRAFT') {
      // 首轮未公开：单位只看本单位草稿数据
      const d = (await tx.query('SELECT * FROM first_round_drafts WHERE event_id = $1 AND project_code = $2 AND unit_code = $3', [eventId, p, unitCode])).rows[0];
      base = d?.base_target_fen ? BigInt(d.base_target_fen) : null;
      firstRoundPp = d?.first_round_pp ?? null;
    } else {
      const s = (await tx.query('SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2 AND unit_code = $3', [eventId, p, unitCode])).rows[0];
      base = BigInt(s.base_target_fen);
      firstRoundPp = s.first_round_pp;
      currentPp = s.current_pp;
      bidVersion = s.version;
      ack = s.base_ack_at ? { at: s.base_ack_at.toISOString(), source: s.base_ack_source } : null;
    }
    perProject[p] = {
      projectCode: p,
      name: PROJECT_NAMES[p],
      status: project.status,
      published: project.status !== 'DRAFT',
      groupStatus: group.status,
      currentGroup: project.currentGroup,
      baseTargetWan: base !== null ? fenToWanExact(base) : null,
      firstRoundPp,
      currentPp,
      currentTargetWan: base !== null && currentPp !== null ? fenToWanExact(targetFen(base, currentPp)) : null,
      bidVersion,
      baseAcknowledged: !!ack,
      baseAcknowledgedAt: ack?.at ?? null,
      baseAckSource: ack?.source ?? null,
    };
  }
  const myBids = await tx.query(
    `SELECT * FROM bid_records WHERE event_id = $1 AND unit_code = $2 ORDER BY event_sequence DESC LIMIT 20`,
    [eventId, unitCode],
  );
  return {
    seq: ev.seq,
    serverTime: new Date().toISOString(),
    event: {
      ...publicEvent(ev),
      allowedIncrementSteps: cfg.allowedIncrementSteps,
      highValueConfirmPp: cfg.highValueConfirmPp,
    },
    unit: { code: unit.code, name: unit.name, groupNo: unit.groupNo, groupName: GROUPS.find((g) => g.groupNo === unit.groupNo)!.name, minIncreasePp: GROUPS.find((g) => g.groupNo === unit.groupNo)!.minIncreasePp },
    projects: perProject,
    myBids: myBids.rows.map((b) => ({
      receiptNo: b.receipt_no,
      projectCode: b.project_code,
      fromPp: b.from_pp,
      toPp: b.to_pp,
      targetWan: fenToWanExact(BigInt(b.target_fen)),
      source: b.source,
      acceptedAt: b.accepted_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------- 管理端

export async function adminState(tx: Tx, eventId: string) {
  const evRow = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const ev = toSummary(evRow);
  const projects = await loadProjects(tx, eventId);
  const boards: Record<string, GroupBoard[]> = {};
  const acks: Record<string, unknown[]> = {};
  for (const p of PROJECT_CODES) {
    if (projects[p].status === 'DRAFT') {
      boards[p] = [];
      acks[p] = [];
      continue;
    }
    const states = await loadStates(tx, eventId, p);
    boards[p] = buildBoards(projects[p], states, true);
    acks[p] = UNITS.map((u) => {
      const s = states.get(u.code)!;
      return {
        unitCode: u.code,
        unitName: u.name,
        acknowledged: !!s.base_ack_at,
        acknowledgedAt: toIso(s.base_ack_at),
        source: s.base_ack_source,
      };
    });
  }
  const failures = await tx.query(
    'SELECT * FROM failed_submissions WHERE event_id = $1 ORDER BY id DESC LIMIT 30',
    [eventId],
  );
  return {
    seq: ev.seq,
    serverTime: new Date().toISOString(),
    event: ev,
    projects,
    boards,
    acks,
    recentBids: await recentBids(tx, eventId, null, 30),
    failures: failures.rows.map((f) => ({
      id: Number(f.id),
      projectCode: f.project_code,
      unitCode: f.unit_code,
      actorType: f.actor_type,
      operation: f.operation,
      errorCode: f.error_code,
      message: f.message,
      createdAt: toIso(f.created_at),
    })),
  };
}

export async function adminFirstRound(tx: Tx, eventId: string) {
  const ev = toSummary((await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0]);
  const projects = await loadProjects(tx, eventId);
  const out: Record<string, unknown> = {};
  for (const p of PROJECT_CODES) {
    const drafts = (await tx.query(
      `SELECT d.*, a.display_name AS updated_by_name FROM first_round_drafts d LEFT JOIN admins a ON a.id = d.updated_by
        WHERE d.event_id = $1 AND d.project_code = $2`,
      [eventId, p],
    )).rows;
    const byUnit = new Map(drafts.map((d) => [d.unit_code, d]));
    const snapshot = projects[p].status !== 'DRAFT'
      ? (await tx.query('SELECT * FROM first_round_snapshots WHERE event_id = $1 AND project_code = $2', [eventId, p])).rows[0]
      : null;
    out[p] = {
      project: projects[p],
      draftRows: UNITS.map((u) => {
        const d = byUnit.get(u.code);
        const base = d?.base_target_fen ? BigInt(d.base_target_fen) : null;
        return {
          unitCode: u.code,
          unitName: u.name,
          groupNo: u.groupNo,
          baseTargetWan: base ? fenToWanExact(base) : null,
          firstRoundPp: d?.first_round_pp ?? null,
          targetWan: base && d?.first_round_pp ? fenToWanExact(targetFen(base, d.first_round_pp)) : null,
          remark: d?.remark ?? null,
          updatedAt: toIso(d?.updated_at),
          updatedBy: d?.updated_by_name ?? null,
        };
      }),
      preview: await firstRoundBoard(tx, eventId, p, { includeDraft: true, withAmounts: true }),
      snapshot: snapshot
        ? { id: snapshot.id, batchNo: snapshot.batch_no, publishedAt: toIso(snapshot.published_at), draftVersion: snapshot.draft_version }
        : null,
    };
  }
  return { seq: ev.seq, draftVersion: ev.draftVersion, projects: out };
}
