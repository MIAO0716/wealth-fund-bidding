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

/**
 * AirScript 一次调用的读写指令（本机 → 脚本）。
 * file 为空：读写脚本所在文件；file 为文件链接：脚本用 KSDrive.openFile 打开该文件再读写（每家单位一个文件的模式）。
 */
export interface KdocsWrite {
  file?: string;
  sheet: string;
  range: string;
  values: unknown[][];
}

export interface KdocsRead {
  file?: string;
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
  /** 脚本版本；1.1 起支持跨文件读写 */
  scriptVersion?: string;
  supportsFiles?: boolean;
  sheets?: string[];
  missingSheets?: string[];
  reads?: Array<{ file?: string; sheet: string; range: string; values: unknown[][] | null; error?: string }>;
  written?: number;
  errors?: string[];
}

// ---------------------------------------------------------------- 每家单位一个文件

/** 金山文档文件链接：https://*.kdocs.cn/... ；模拟金山文档为 mock://文件编号 */
export function isKdocsFileUrl(url: string, allowMock = false): boolean {
  if (allowMock && /^mock:\/\/[A-Za-z0-9_-]+$/.test(url)) return true;
  return /^https:\/\/([A-Za-z0-9-]+\.)*kdocs\.cn\/[^\s]+$/.test(url) && !/\/api\/v3\/ide\//.test(url);
}

export interface ParsedUnitFiles {
  files: Record<string, string>;
  /** 无法识别的行 */
  errors: string[];
  missing: string[];
}

/**
 * 解析「单位名称 + 文件链接」清单，每行一家，顺序不限，例如：
 *   浦东 https://www.kdocs.cn/l/abc123
 *   闵行：https://www.kdocs.cn/l/def456
 * 也可以是金山分享时复制的「【金山文档】 浦东 https://...」。
 */
export function parseUnitFiles(text: string, units: ReadonlyArray<{ code: string; name: string }>, allowMock = false): ParsedUnitFiles {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /(https:\/\/\S+|mock:\/\/[A-Za-z0-9_-]+)/.exec(line);
    const url = m?.[1].replace(/[，。,;；）)」】]+$/, '');
    const rest = m ? line.replace(m[1], ' ') : line;
    const hits = units.filter((u) => rest.includes(u.name));
    if (!url || !isKdocsFileUrl(url, allowMock)) {
      errors.push(`无法识别链接：${line.slice(0, 60)}`);
      continue;
    }
    if (hits.length !== 1) {
      errors.push(hits.length ? `一行只能写一家单位：${line.slice(0, 60)}` : `没有找到单位名称：${line.slice(0, 60)}`);
      continue;
    }
    const u = hits[0];
    if (files[u.code] && files[u.code] !== url) errors.push(`${u.name}出现了两个不同的链接`);
    files[u.code] = url;
  }
  const used = new Map<string, string>();
  for (const [code, url] of Object.entries(files)) {
    const other = used.get(url);
    if (other) errors.push(`${units.find((u) => u.code === other)?.name}和${units.find((u) => u.code === code)?.name}用了同一个文件链接`);
    used.set(url, code);
  }
  return { files, errors, missing: units.filter((u) => !files[u.code]).map((u) => u.name) };
}
