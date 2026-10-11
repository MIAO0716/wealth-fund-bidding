/**
 * 金山文档接入：每个单位一张工作表（表名 = 单位名称），版式固定。
 * 本机程序只通过 AirScript 读写单元格；规则判断全部在本机完成。
 *
 *   A1        标题
 *   A2:B10    本单位信息（程序写入，领导只读）
 *   D2:E2     最近同步时间（程序写入）
 *   A11:C11   确认认领底标：B11 由领导选「确认」，C11 为程序回写的状态
 *   A12:E12   报价表头
 *   A13:E..   报价行：B「加到（%）」、C「确认」由领导填写；D「处理结果」、E「处理时间」由程序回写
 */

export const KDOCS_PROTOCOL = 1;

export const KDOCS_LAYOUT = {
  titleCell: 'A1',
  infoLabels: [
    '单位',
    '组别',
    '当前专场',
    '状态',
    '底标（万元）',
    '首轮增幅',
    '当前生效增幅',
    '当前目标（万元）',
    '下一步可选「加到」',
  ],
  /** 信息值所在区域（B2:B10，与 infoLabels 一一对应） */
  infoValueRange: 'B2:B10',
  syncLabelCell: 'D2',
  syncValueCell: 'E2',
  ackRow: 11,
  ackLabel: '确认认领底标 →',
  headerRow: 12,
  headers: ['序号', '加到（%）', '确认', '处理结果', '处理时间'],
  firstBidRow: 13,
  defaultBidRows: 40,
} as const;

export const KDOCS_CONFIRM_WORD = '确认';

export function bidRowRange(maxRows: number): { first: number; last: number } {
  return { first: KDOCS_LAYOUT.firstBidRow, last: KDOCS_LAYOUT.firstBidRow + maxRows - 1 };
}

/** 程序每轮读取的区域：B11:C{最后一行}（底标确认 + 报价行的「加到」「确认」两列） */
export function kdocsReadRange(maxRows: number): string {
  return `B${KDOCS_LAYOUT.ackRow}:C${bidRowRange(maxRows).last}`;
}

/** 单元格值是否表示「确认」：确认 / 是 / √ / ✓ / TRUE（复选框） */
export function isConfirmCell(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return ['确认', '是', '√', '✓', '✔', 'true', 'yes', 'y'].includes(s);
}

export function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export type ParsedTarget = { ok: true; pp: number } | { ok: false; reason: string };

const FULLWIDTH = /[０-９．％]/g;

/**
 * 解析「加到（%）」：35、"35"、"35%"、全角“３５％”；设置了百分比格式的单元格读出 0.35 时按 35 处理。
 * 只接受整数个百分点。
 */
export function parseTargetCell(v: unknown): ParsedTarget {
  if (isBlankCell(v)) return { ok: false, reason: '未填写' };
  let n: number;
  if (typeof v === 'number') {
    n = v > 0 && v < 1.5 ? v * 100 : v;
  } else if (typeof v === 'string') {
    const s = v
      .replace(FULLWIDTH, (c) => (c === '％' ? '%' : c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
      .replace(/\s+/g, '');
    const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(s);
    if (!m) return { ok: false, reason: `无法识别「${String(v).slice(0, 20)}」，请填写数字，如 35` };
    n = Number(m[1]);
  } else {
    return { ok: false, reason: '无法识别，请填写数字，如 35' };
  }
  const rounded = Math.round(n * 1e6) / 1e6;
  if (!Number.isFinite(rounded) || !Number.isInteger(rounded)) return { ok: false, reason: `「${String(v)}」不是整数个百分点` };
  if (rounded <= 0 || rounded > 1000) return { ok: false, reason: `「${String(v)}」超出范围` };
  return { ok: true, pp: rounded };
}

/** AirScript 一次调用的读写指令（本机 → 脚本） */
export interface KdocsWrite {
  sheet: string;
  range: string;
  values: unknown[][];
}

export interface KdocsRead {
  sheet: string;
  range: string;
}

export interface KdocsBatchArgv {
  protocol: number;
  action: 'ping' | 'batch';
  writes?: KdocsWrite[];
  reads?: KdocsRead[];
}

/** 脚本返回（脚本 → 本机） */
export interface KdocsBatchResult {
  protocol: number;
  ok: boolean;
  sheets?: string[];
  missingSheets?: string[];
  reads?: Array<{ sheet: string; range: string; values: unknown[][] | null; error?: string }>;
  written?: number;
  errors?: string[];
}
