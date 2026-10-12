/** 竞标业务规则：前后端共用，后端以此为准独立校验。 */

/** 加码最小单位：1 个百分点（2027 年一季度方案 6.0：每次加码为 1 的整数倍，组内自由加码） */
export const STEP_PP = 1;
/** 手机端与代录的快捷档位（只是快捷按钮，可任意填写整数；服务端不限制必须是这些档位） */
export const DEFAULT_ALLOWED_INCREMENT_STEPS = [1, 5, 10] as const;
/** 标王门槛：30% 及以上 */
export const CHAMPION_THRESHOLD_PP = 30;
/** 技术上可处理的最大增幅（不是业务封顶，只防止溢出与误录） */
export const TECHNICAL_MAX_PP = 100_000;
/** 默认：增幅达到该值时要求再次明确确认（不是上限） */
export const DEFAULT_HIGH_VALUE_CONFIRM_PP = 100;

export type ProjectStatus = 'DRAFT' | 'ROUND1_PUBLISHED' | 'LIVE' | 'PAUSED' | 'LOCKED';
export type GroupStatus = 'WAITING' | 'OPEN' | 'CLOSED';

export const PROJECT_STATUS_NAMES: Record<ProjectStatus, string> = {
  DRAFT: '草稿',
  ROUND1_PUBLISHED: '首轮已发布',
  LIVE: '竞标中',
  PAUSED: '已暂停',
  LOCKED: '已锁定',
};

export const GROUP_STATUS_NAMES: Record<GroupStatus, string> = {
  WAITING: '等待',
  OPEN: '进行中',
  CLOSED: '已结束',
};

/** 合法状态转换：DRAFT → ROUND1_PUBLISHED → LIVE ↔ PAUSED → LOCKED */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ['ROUND1_PUBLISHED'],
  ROUND1_PUBLISHED: ['LIVE'],
  LIVE: ['PAUSED'],
  PAUSED: ['LIVE', 'LOCKED'],
  LOCKED: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

/** 校验快捷档位配置：正整数、去重、升序、非空 */
export function normalizeAllowedSteps(steps: unknown): number[] | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const out = new Set<number>();
  for (const s of steps) {
    if (typeof s !== 'number' || !Number.isInteger(s) || s <= 0 || s > 1000) return null;
    out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

export type PpCheck = { ok: true } | { ok: false; reason: string };

/** 申报增幅本身的格式校验：整数百分点、技术范围内 */
export function checkIncreasePpFormat(pp: unknown, label = '增幅'): PpCheck {
  if (pp === null || pp === undefined || pp === '') return { ok: false, reason: `${label}为必填项` };
  if (typeof pp !== 'number' || !Number.isFinite(pp)) {
    return { ok: false, reason: `${label}须为整数百分点（30 代表 30%），不能写成 "30%"` };
  }
  if (!Number.isInteger(pp)) {
    if (pp > 0 && pp < 1) {
      return { ok: false, reason: `${label}须为整数百分点：30% 请填 30，不要填 ${pp}` };
    }
    return { ok: false, reason: `${label} ${pp} 不是整数百分点` };
  }
  if (pp <= 0) return { ok: false, reason: `${label}必须大于 0` };
  if (pp > TECHNICAL_MAX_PP) return { ok: false, reason: `${label} ${pp} 超出系统可处理范围` };
  return { ok: true };
}

export function checkGroupMinimum(pp: number, groupMin: number, groupName: string): PpCheck {
  if (pp < groupMin) {
    return { ok: false, reason: `${pp}% 低于${groupName}最低增幅 ${groupMin}%` };
  }
  return { ok: true };
}

export type BidCheckCode = 'INVALID_STEP' | 'NOT_GREATER' | 'INVALID_VALUE';

export type BidCheck = { ok: true; deltaPp: number } | { ok: false; code: BidCheckCode; reason: string };

/** 追加校验：目标值为整数百分点、大于当前值（每次至少 1 个百分点）、满足组别底线 */
export function checkBidTarget(params: { currentPp: number; targetPp: unknown; groupMinPp: number }): BidCheck {
  const { currentPp, targetPp, groupMinPp } = params;
  if (typeof targetPp !== 'number' || !Number.isInteger(targetPp)) {
    return { ok: false, code: 'INVALID_VALUE', reason: '目标增幅须为整数百分点' };
  }
  if (targetPp <= currentPp) {
    return { ok: false, code: 'NOT_GREATER', reason: `新增幅 ${targetPp}% 必须高于已确认增幅 ${currentPp}%` };
  }
  if (targetPp > TECHNICAL_MAX_PP) {
    return { ok: false, code: 'INVALID_VALUE', reason: '目标增幅超出系统可处理范围' };
  }
  const delta = targetPp - currentPp;
  if (targetPp < groupMinPp) {
    return { ok: false, code: 'INVALID_STEP', reason: `目标增幅低于组别最低增幅 ${groupMinPp}%` };
  }
  return { ok: true, deltaPp: delta };
}

export type LeaderStatus = 'CHAMPION_CANDIDATE' | 'TIED_PENDING' | 'GROUP_LEADER' | 'NONE';

export interface RankInput {
  unitCode: string;
  displayOrder: number;
  increasePp: number | null;
}

export interface RankedRow {
  unitCode: string;
  increasePp: number | null;
  /** 并列名次（1,1,3）；缺失数据为 null */
  rank: number | null;
  /** 是否组内第一（可能并列） */
  isTop: boolean;
}

export interface GroupRanking {
  rows: RankedRow[];
  topPp: number | null;
  topUnitCodes: string[];
  tiedTop: boolean;
  leaderStatus: LeaderStatus;
}

/**
 * 组内排名：按增幅从高到低，并列使用竞赛排名（1,1,3）。
 * 并列行按预设单位顺序稳定展示，不以时间或单位顺序决定名次。缺失行不参与排名，排在最后。
 */
export function rankGroup(inputs: RankInput[], thresholdPp = CHAMPION_THRESHOLD_PP): GroupRanking {
  const present = inputs.filter((r) => r.increasePp !== null);
  const missing = inputs.filter((r) => r.increasePp === null).sort((a, b) => a.displayOrder - b.displayOrder);
  present.sort((a, b) => (b.increasePp! - a.increasePp!) || a.displayOrder - b.displayOrder);
  const rows: RankedRow[] = [];
  let lastPp: number | null = null;
  let lastRank = 0;
  present.forEach((r, i) => {
    const rank = r.increasePp === lastPp ? lastRank : i + 1;
    lastPp = r.increasePp;
    lastRank = rank;
    rows.push({ unitCode: r.unitCode, increasePp: r.increasePp, rank, isTop: rank === 1 });
  });
  for (const r of missing) rows.push({ unitCode: r.unitCode, increasePp: null, rank: null, isTop: false });
  const top = rows.filter((r) => r.isTop);
  const topPp = top.length ? top[0].increasePp : null;
  const tiedTop = top.length > 1;
  let leaderStatus: LeaderStatus = 'NONE';
  if (topPp !== null) {
    if (topPp >= thresholdPp) leaderStatus = tiedTop ? 'TIED_PENDING' : 'CHAMPION_CANDIDATE';
    else leaderStatus = 'GROUP_LEADER';
  }
  return { rows, topPp, topUnitCodes: top.map((r) => r.unitCode), tiedTop, leaderStatus };
}

export const LEADER_STATUS_LABELS: Record<LeaderStatus, string> = {
  CHAMPION_CANDIDATE: '标王候选',
  TIED_PENDING: '并列领先·待确认',
  GROUP_LEADER: '组内领先',
  NONE: '',
};

/** 锁定后的展示：仅无并列且达到门槛的第一名显示「现场标王」 */
export function lockedLeaderLabel(status: LeaderStatus): string {
  if (status === 'CHAMPION_CANDIDATE') return '现场标王';
  if (status === 'TIED_PENDING') return '并列第一·授旗规则待确认';
  if (status === 'GROUP_LEADER') return '组内领先（未达30%门槛）';
  return '';
}
