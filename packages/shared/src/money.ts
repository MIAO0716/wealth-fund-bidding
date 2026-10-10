/**
 * 金额精确计算。内部一律用「人民币分」的 bigint；接口传十进制字符串。
 * 1 万元 = 1,000,000 分，所以「万元」最多 6 位小数即精确到分。
 */

export const FEN_PER_WAN = 1_000_000n;

const WAN_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;

export type ParseWanResult = { ok: true; fen: bigint } | { ok: false; reason: string };

/** 解析「万元」十进制字符串为分。不取整、不纠错。 */
export function parseWanToFen(input: unknown): ParseWanResult {
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    return { ok: false, reason: '基础底标为必填项' };
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: '基础底标须为十进制字符串，例如 "100.00"' };
  }
  const s = input.trim();
  if (s.startsWith('-')) return { ok: false, reason: '基础底标必须大于 0' };
  if (/^\d+\.\d{7,}$/.test(s)) {
    return { ok: false, reason: '基础底标最多 6 位小数（精确到人民币分）' };
  }
  if (!WAN_PATTERN.test(s)) {
    return { ok: false, reason: `基础底标「${s}」不是合法金额（单位万元，例如 100 或 123.45）` };
  }
  const [intPart, fracPart = ''] = s.split('.');
  const fen = BigInt(intPart) * FEN_PER_WAN + BigInt(fracPart.padEnd(6, '0'));
  if (fen <= 0n) return { ok: false, reason: '基础底标必须大于 0' };
  return { ok: true, fen };
}

/** 竞标目标金额（分）= 底标 × (100 + 增幅) ÷ 100，按分四舍五入 */
export function targetFen(baseFen: bigint, increasePp: number): bigint {
  if (!Number.isInteger(increasePp)) throw new Error('增幅必须是整数百分点');
  const numerator = baseFen * BigInt(100 + increasePp);
  // 正数四舍五入
  return (numerator + 50n) / 100n;
}

/** 分 → 万元精确字符串（6 位小数，去掉多余 0，至少保留 2 位） */
export function fenToWanExact(fen: bigint): string {
  const neg = fen < 0n;
  const abs = neg ? -fen : fen;
  const intPart = abs / FEN_PER_WAN;
  let frac = (abs % FEN_PER_WAN).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${intPart}.${frac}`;
}

/** 分 → 万元展示字符串，保留 2 位小数（四舍五入），带千分位 */
export function fenToWanDisplay(fen: bigint, withSeparator = true): string {
  const neg = fen < 0n;
  const abs = neg ? -fen : fen;
  // 1 万元 = 1e6 分；两位小数 = 1e4 分
  const hundredths = (abs + 5_000n) / 10_000n;
  const intPart = (hundredths / 100n).toString();
  const frac = (hundredths % 100n).toString().padStart(2, '0');
  const intStr = withSeparator ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  return `${neg ? '-' : ''}${intStr}.${frac}`;
}

/** 分 → 元精确字符串（2 位小数） */
export function fenToYuan(fen: bigint): string {
  const neg = fen < 0n;
  const abs = neg ? -fen : fen;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
