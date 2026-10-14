/** 展示格式：时间按 Asia/Shanghai，万元保留 2 位小数 */

export function fmtTime(iso: string | null | undefined, withDate = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
  };
  return new Intl.DateTimeFormat('zh-CN', opts).format(d);
}

/** 精确万元字符串 → 2 位小数展示（四舍五入，字符串运算避免浮点误差） */
export function wan2(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const [i, f = ''] = v.split('.');
  const frac6 = (f + '000000').slice(0, 6);
  let hundredths = BigInt(i) * 100n + BigInt(frac6.slice(0, 2));
  if (Number(frac6[2]) >= 5) hundredths += 1n;
  const ip = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${ip}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** 前端预览目标金额（万元），与服务端同一公式：底标 × (100 + 增幅) ÷ 100，按分四舍五入 */
export function previewTargetWan(baseWan: string, pp: number): string {
  const [i, f = ''] = baseWan.split('.');
  const fen = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  const t = (fen * BigInt(100 + pp) + 50n) / 100n;
  const ip = t / 1_000_000n;
  const fp = (t % 1_000_000n).toString().padStart(6, '0');
  return `${ip}.${fp}`;
}

/** 精确万元字符串 → 整数万元展示（四舍五入，不显示小数；字符串运算避免浮点误差） */
export function wan0(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const [i, f = ''] = v.split('.');
  let n = BigInt(i);
  if (Number((f + '0')[0]) >= 5) n += 1n;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 分 → 亿元，保留 2 位小数（四舍五入，整数运算避免浮点误差） */
export function fenToYi2(fen: string | null | undefined): string {
  if (fen === null || fen === undefined) return '—';
  const h = (BigInt(fen) + 50_000_000n) / 100_000_000n; // 0.01 亿元 = 1 亿分
  const ip = (h / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${ip}.${(h % 100n).toString().padStart(2, '0')}`;
}

/** 增幅百分比（目标 ÷ 底标 − 1），保留 2 位小数 */
export function increasePct2(baseFen: string, targetFen: string): string {
  const b = BigInt(baseFen);
  if (b === 0n) return '—';
  const diff = BigInt(targetFen) - b;
  const neg = diff < 0n;
  const abs = neg ? -diff : diff;
  const h = (abs * 10_000n * 2n + b) / (2n * b); // 百分之一个百分点
  return `${neg ? '-' : ''}${h / 100n}.${(h % 100n).toString().padStart(2, '0')}`;
}

/** 分 → 亿元，四舍五入取整 */
export function fenToYi0(fen: string | null | undefined): string {
  if (fen === null || fen === undefined) return '—';
  return ((BigInt(fen) + 5_000_000_000n) / 10_000_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 增幅百分比（目标 ÷ 底标 − 1），按精确金额计算后四舍五入取整 */
export function increasePct0(baseFen: string, targetFen: string): string {
  const b = BigInt(baseFen);
  if (b === 0n) return '—';
  const diff = BigInt(targetFen) - b;
  const neg = diff < 0n;
  const abs = neg ? -diff : diff;
  return `${neg ? '-' : ''}${(abs * 100n * 2n + b) / (2n * b)}`;
}
