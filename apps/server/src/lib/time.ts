/** 时间统一存 UTC；界面与导出按 Asia/Shanghai（UTC+8，无夏令时）显示 */

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

/** 格式化为上海时间 yyyy-MM-dd HH:mm:ss */
export function formatShanghai(d: Date | string | null | undefined): string {
  if (!d) return '';
  const t = new Date((d instanceof Date ? d : new Date(d)).getTime() + SHANGHAI_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** 某个上海日期（YYYY-MM-DD）当天结束的 UTC 时刻 */
export function endOfShanghaiDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const utcMidnightNext = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return new Date(utcMidnightNext - SHANGHAI_OFFSET_MS - 1000);
}

export function shanghaiDateCompact(d: Date = new Date()): string {
  return formatShanghai(d).slice(0, 19).replace(/[-: ]/g, '').slice(0, 14);
}
