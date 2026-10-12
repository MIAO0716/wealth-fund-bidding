import { describe, expect, it } from 'vitest';
import {
  checkBidTarget,
  checkIncreasePpFormat,
  fenToWanDisplay,
  fenToWanExact,
  normalizeAllowedSteps,
  parseWanToFen,
  rankGroup,
  targetFen,
} from '../src';

describe('金额', () => {
  it('万元字符串精确转换为分', () => {
    expect(parseWanToFen('100')).toEqual({ ok: true, fen: 100_000_000n });
    expect(parseWanToFen('123.45')).toEqual({ ok: true, fen: 123_450_000n });
    expect(parseWanToFen('0.000001')).toEqual({ ok: true, fen: 1n });
  });

  it('拒绝非法金额且不取整', () => {
    expect(parseWanToFen('0').ok).toBe(false);
    expect(parseWanToFen('-5').ok).toBe(false);
    expect(parseWanToFen('1.0000001').ok).toBe(false);
    expect(parseWanToFen('abc').ok).toBe(false);
    expect(parseWanToFen(100).ok).toBe(false);
    expect(parseWanToFen('').ok).toBe(false);
    expect(parseWanToFen(null).ok).toBe(false);
  });

  it('目标 = 底标 × (100 + 增幅) ÷ 100，不复利', () => {
    const base = 100_000_000n; // 100 万元
    expect(fenToWanExact(targetFen(base, 30))).toBe('130.00');
    expect(fenToWanExact(targetFen(base, 35))).toBe('135.00');
    // 禁止 130 × 1.05 = 136.5
    expect(targetFen(base, 35)).not.toBe((targetFen(base, 30) * 105n) / 100n);
  });

  it('按分四舍五入', () => {
    // 0.000003 万元 = 3 分；×1.35 = 4.05 分 → 4 分
    expect(targetFen(3n, 35)).toBe(4n);
    // 1 分 ×1.5 = 1.5 分 → 2 分
    expect(targetFen(1n, 50)).toBe(2n);
  });

  it('展示保留 2 位小数并带千分位', () => {
    expect(fenToWanDisplay(1_234_567_890n)).toBe('1,234.57');
    expect(fenToWanDisplay(5_000n)).toBe('0.01');
  });
});

describe('增幅格式', () => {
  it('必须是整数百分点（1 的整数倍）', () => {
    expect(checkIncreasePpFormat(30).ok).toBe(true);
    expect(checkIncreasePpFormat(12).ok).toBe(true);
    expect(checkIncreasePpFormat(7.5).ok).toBe(false);
    expect(checkIncreasePpFormat('30%').ok).toBe(false);
    const r = checkIncreasePpFormat(0.3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('请填 30');
  });

  it('快捷档位配置校验：正整数、去重、升序', () => {
    expect(normalizeAllowedSteps([10, 5, 5, 1])).toEqual([1, 5, 10]);
    expect(normalizeAllowedSteps([5, 7])).toEqual([5, 7]);
    expect(normalizeAllowedSteps([0])).toBeNull();
    expect(normalizeAllowedSteps([2.5])).toBeNull();
    expect(normalizeAllowedSteps([])).toBeNull();
  });
});

describe('追加校验（每次加码为 1 的整数倍，组内自由加码）', () => {
  const base = { currentPp: 30, groupMinPp: 10 };

  it('任意整数加码均合法：+1、+3、+10、+25', () => {
    expect(checkBidTarget({ ...base, targetPp: 31 })).toEqual({ ok: true, deltaPp: 1 });
    expect(checkBidTarget({ ...base, targetPp: 33 })).toEqual({ ok: true, deltaPp: 3 });
    expect(checkBidTarget({ ...base, targetPp: 40 })).toEqual({ ok: true, deltaPp: 10 });
    expect(checkBidTarget({ ...base, targetPp: 55 })).toEqual({ ok: true, deltaPp: 25 });
  });

  it('不高于当前值、小数、低于组别底线均被拒绝', () => {
    expect(checkBidTarget({ ...base, targetPp: 30 })).toMatchObject({ ok: false, code: 'NOT_GREATER' });
    expect(checkBidTarget({ ...base, targetPp: 25 })).toMatchObject({ ok: false, code: 'NOT_GREATER' });
    expect(checkBidTarget({ ...base, targetPp: 30.5 })).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
    expect(checkBidTarget({ currentPp: 5, groupMinPp: 10, targetPp: 8 })).toMatchObject({ ok: false, code: 'INVALID_STEP' });
  });
});

describe('组内排名', () => {
  const rows = (pps: Array<number | null>) => pps.map((pp, i) => ({ unitCode: `U${i}`, displayOrder: i, increasePp: pp }));

  it('并列使用 1、1、3', () => {
    const r = rankGroup(rows([30, 25, 30]));
    expect(r.rows.map((x) => [x.unitCode, x.rank])).toEqual([
      ['U0', 1],
      ['U2', 1],
      ['U1', 3],
    ]);
    expect(r.tiedTop).toBe(true);
    expect(r.leaderStatus).toBe('TIED_PENDING');
  });

  it('第一名不足 30% 显示组内领先', () => {
    expect(rankGroup(rows([25, 20, 10])).leaderStatus).toBe('GROUP_LEADER');
  });

  it('唯一第一且达到 30% 为标王候选', () => {
    const r = rankGroup(rows([30, 25]));
    expect(r.leaderStatus).toBe('CHAMPION_CANDIDATE');
    expect(r.topUnitCodes).toEqual(['U0']);
  });

  it('缺失行不参与排名', () => {
    const r = rankGroup(rows([null, 20, 15]));
    expect(r.rows.map((x) => x.rank)).toEqual([1, 2, null]);
  });
});
