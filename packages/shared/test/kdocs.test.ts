import { describe, expect, it } from 'vitest';
import { isConfirmCell, kdocsReadRange, parseTargetCell } from '../src/kdocs';

describe('金山文档单元格解析', () => {
  it('「加到」：数字、文本、百分号、全角、百分比格式均可识别', () => {
    expect(parseTargetCell(35)).toEqual({ ok: true, pp: 35 });
    expect(parseTargetCell('35')).toEqual({ ok: true, pp: 35 });
    expect(parseTargetCell(' 35% ')).toEqual({ ok: true, pp: 35 });
    expect(parseTargetCell('３５％')).toEqual({ ok: true, pp: 35 });
    expect(parseTargetCell(0.35)).toEqual({ ok: true, pp: 35 });
    expect(parseTargetCell(1.2)).toEqual({ ok: true, pp: 120 });
  });

  it('非整数、文字、空白、超范围均拒绝并说明', () => {
    expect(parseTargetCell('')).toMatchObject({ ok: false, reason: '未填写' });
    expect(parseTargetCell(null)).toMatchObject({ ok: false });
    expect(parseTargetCell('三十五')).toMatchObject({ ok: false });
    expect(parseTargetCell('35.5')).toMatchObject({ ok: false });
    expect(parseTargetCell(-5)).toMatchObject({ ok: false });
    expect(parseTargetCell(5000)).toMatchObject({ ok: false });
  });

  it('「确认」：确认 / 是 / √ / 复选框', () => {
    for (const v of ['确认', ' 是 ', '√', '✓', true, 'TRUE']) expect(isConfirmCell(v)).toBe(true);
    for (const v of ['', null, '否', false, 1, '确定吗']) expect(isConfirmCell(v)).toBe(false);
  });

  it('读取区域覆盖底标确认与全部报价行', () => {
    expect(kdocsReadRange(40)).toBe('B11:C52');
  });
});

describe('单位文件链接清单', () => {
  const units = [
    { code: 'PD', name: '浦东' },
    { code: 'MH', name: '闵行' },
  ];
  it('每行「单位 链接」，顺序与分隔符不限；金山分享文案也能识别', async () => {
    const { parseUnitFiles } = await import('../src/kdocs');
    const r = parseUnitFiles('【金山文档】 闵行竞标表\nhttps://www.kdocs.cn/l/xyz789 闵行\n浦东：https://www.kdocs.cn/l/abc123，', units);
    expect(r.errors).toHaveLength(1); // 第一行只有单位没有链接
    expect(r.files).toEqual({ PD: 'https://www.kdocs.cn/l/abc123', MH: 'https://www.kdocs.cn/l/xyz789' });
    expect(r.missing).toEqual([]);
  });
  it('脚本 webhook 链接不能当作单位文件链接', async () => {
    const { parseUnitFiles } = await import('../src/kdocs');
    const r = parseUnitFiles('浦东 https://www.kdocs.cn/api/v3/ide/file/a/script/b/sync_task', units);
    expect(r.errors[0]).toContain('无法识别链接');
    expect(r.missing).toEqual(['浦东', '闵行']);
  });
});
