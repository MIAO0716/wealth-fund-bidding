/**
 * 金山文档接入：每个单位一张工作表（表名 = 单位名称），极简版式，只有 A、B 两列，手机竖屏一屏看全：
 *
 *   A1        标题（单位 · 组别）
 *   A2:B5     状态 / 底标 / 当前增幅 / 可以加到（程序写入，领导只读）
 *   B6        我要加到 —— 全表唯一由领导填写的格子
 *   B7        处理结果（程序回写）
 *   B8        填写说明
 *   B9        最近读取时间
 *
 * 工作人员点「读取金山表格」时，B6 里的数字就是领导的决定；处理后程序清空 B6，结果写在 B7。
 * 本专场第一次填写即视为确认认领底标。
 */

export const KDOCS_PROTOCOL = 1;

export const KDOCS_LAYOUT = {
  titleCell: 'A1',
  /** A2:A9 的标签 */
  labels: ['状态', '底标', '当前增幅', '可以加到', '我要加到', '处理结果', '说明', '最近读取'],
  /** 信息值所在区域（B2:B5，对应 状态 / 底标 / 当前增幅 / 可以加到） */
  infoValueRange: 'B2:B5',
  inputRow: 6,
  inputCell: 'B6',
  resultCell: 'B7',
  noteCell: 'B8',
  syncCell: 'B9',
  lastRow: 9,
  note: '只填黄色格子：填一个数字（如 40），填好后告诉工作人员读取。首次填写即视为确认本专场底标。',
  /** 旧版式（多行报价表）残留区域：写入版式时清空 */
  legacyRanges: ['C1:F9', 'A10:F60'],
} as const;

/** 程序每次读取的区域：只有「我要加到」一个格子 */
export function kdocsReadRange(): string {
  return KDOCS_LAYOUT.inputCell;
}

export function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export type ParsedTarget = { ok: true; pp: number } | { ok: false; reason: string };

const FULLWIDTH = /[０-９．％]/g;

/**
 * 解析「我要加到」：只接受整数个百分点，例如 40、"40"、"40%"、全角“４０％”都表示 40%。
 * 不按数值大小猜测含义：数字 1 就是 1%（会因不合规则而不生效），不会被当作 100%；
 * 0.4 这类小数（格子被设成百分比格式时读出的值）含义不明，直接拒绝并提示。
 */
export function parseTargetCell(v: unknown): ParsedTarget {
  if (isBlankCell(v)) return { ok: false, reason: '未填写' };
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const s = v
      .replace(FULLWIDTH, (c) => (c === '％' ? '%' : c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
      .replace(/\s+/g, '');
    const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(s);
    if (!m) return { ok: false, reason: `无法识别「${String(v).slice(0, 20)}」，请填写整数，如 40` };
    n = Number(m[1]);
  } else {
    return { ok: false, reason: '无法识别，请填写整数，如 40' };
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, reason: `「${String(v)}」不是整数：请直接填写整数，如 40（不要把格子设成百分比格式）` };
  }
  if (n <= 0 || n > 1000) return { ok: false, reason: `「${String(v)}」超出范围` };
  return { ok: true, pp: n };
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
  /** 条件写入（脚本 1.3 起）：只有该区域（单个格子）当前的值仍等于 expect 时才写入，避免清掉领导刚改的内容 */
  expect?: unknown;
}

/** 单元格格式（脚本 1.3 起，尽力而为：金山不支持的属性会被忽略，不影响读写） */
export interface KdocsFormat {
  file?: string;
  sheet: string;
  range: string;
  /** 底色（RGB 十六进制如 'C8102E'；null 表示清除底色） */
  fill?: string | null;
  fontColor?: string;
  fontSize?: number;
  bold?: boolean;
  hAlign?: 'left' | 'center' | 'right';
  vCenter?: boolean;
  wrap?: boolean;
  colWidth?: number;
  rowHeight?: number;
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
  formats?: KdocsFormat[];
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
  /** 条件写入因内容已变化而跳过的数量 */
  skipped?: number;
  /** 1.3 起：支持条件写入与格式 */
  supportsExpect?: boolean;
  /** 1.4 起：与 writes 一一对应的写入结果 */
  writeStatus?: Array<'ok' | 'skipped' | 'error'>;
  formatted?: number;
  formatErrors?: string[];
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
