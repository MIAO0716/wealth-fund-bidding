/**
 * 金山表格模板（.xlsx）：导入金山文档后即得到 16 张单位工作表 + 使用说明，版式与程序读写位置一致。
 * 信息区内容由程序同步时写入，模板中留空。
 */

import { GROUPS, KDOCS_LAYOUT, UNITS, bidRowRange } from '@bidding/shared';
import ExcelJS from 'exceljs';

const RED = 'FFB91C1C';
const RED_LIGHT = 'FFFDECEC';
const GOLD_LIGHT = 'FFFFF7E0';
const GREY = 'FFF3F4F6';

export async function buildKdocsTemplate(opts: { title: string; maxRows: number; targetMax?: number }): Promise<Buffer> {
  const { title, maxRows } = opts;
  const { first, last } = bidRowRange(maxRows);
  const targets = Array.from({ length: Math.floor((opts.targetMax ?? 120) / 5) }, (_, i) => (i + 1) * 5);
  const wb = new ExcelJS.Workbook();
  wb.creator = '理财、基金现场竞标系统';

  // 使用说明
  const guide = wb.addWorksheet('使用说明');
  guide.getColumn(1).width = 110;
  const lines = [
    `${title} · 金山文档填报表`,
    '',
    '【领导】',
    '1. 打开本单位的工作表（表名即单位名称）。',
    `2. 专场开始后，在 B${KDOCS_LAYOUT.ackRow} 选择「确认」，认领本专场的基础底标；C${KDOCS_LAYOUT.ackRow} 显示「已确认」即可。`,
    `3. 轮到本组时，在第 ${first} 行起的空行：B 列选「加到多少」（如 35），C 列选「确认」。`,
    '4. 几秒后 D 列显示处理结果：「✔ 已生效」即成功；「✘ 未生效」会写明原因。',
    '5. 每行只处理一次，处理后再改无效；再次加码请填下一行。增幅只增不减，填低了不会生效。',
    '6. 信息区（第 2–10 行）显示当前生效增幅、目标金额和「下一步可选」的数值，以此为准。',
    '',
    '【工作人员】',
    '1. 只保留本说明表和 16 张单位工作表，不要改表名、不要插入或删除行列。',
    '2. 为每张单位工作表设置区域权限：该单位领导只能编辑 B11 与报价区的 B、C 两列，其余单元格只读。',
    '3. 在本文件中打开 AirScript 脚本编辑器，粘贴管理端下载的脚本，生成脚本令牌，复制 webhook 链接。',
    '4. 详细步骤见《金山文档接入说明》。',
  ];
  lines.forEach((t, i) => {
    const c = guide.getCell(`A${i + 1}`);
    c.value = t;
    if (i === 0) c.font = { bold: true, size: 14, color: { argb: RED } };
    else if (t.startsWith('【')) c.font = { bold: true };
  });

  for (const u of UNITS) {
    const ws = wb.addWorksheet(u.name, { views: [{ state: 'frozen', ySplit: KDOCS_LAYOUT.headerRow }] });
    ws.columns = [{ width: 18 }, { width: 22 }, { width: 14 }, { width: 46 }, { width: 12 }];
    const group = GROUPS.find((g) => g.groupNo === u.groupNo)!;

    ws.mergeCells('A1:E1');
    const t = ws.getCell('A1');
    t.value = `${u.name} · ${title}（${group.name}）`;
    t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
    t.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 26;

    KDOCS_LAYOUT.infoLabels.forEach((label, i) => {
      const r = 2 + i;
      const a = ws.getCell(`A${r}`);
      a.value = label;
      a.font = { color: { argb: 'FF6B7280' } };
      const b = ws.getCell(`B${r}`);
      b.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
      b.font = { bold: true };
    });
    ws.getCell(KDOCS_LAYOUT.syncLabelCell).value = '最近同步';
    ws.getCell(KDOCS_LAYOUT.syncLabelCell).font = { color: { argb: 'FF6B7280' } };

    const ackRow = KDOCS_LAYOUT.ackRow;
    ws.getCell(`A${ackRow}`).value = KDOCS_LAYOUT.ackLabel;
    ws.getCell(`A${ackRow}`).font = { bold: true, color: { argb: RED } };
    const ackCell = ws.getCell(`B${ackRow}`);
    ackCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
    ackCell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"确认"'], showErrorMessage: true, error: '请选择「确认」' };
    ws.getCell(`C${ackRow}`).font = { color: { argb: 'FF6B7280' } };

    const header = ws.getRow(KDOCS_LAYOUT.headerRow);
    KDOCS_LAYOUT.headers.forEach((h, i) => {
      const c = header.getCell(i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
      c.alignment = { horizontal: 'center' };
    });

    for (let r = first; r <= last; r++) {
      ws.getCell(`A${r}`).value = r - first + 1;
      ws.getCell(`A${r}`).alignment = { horizontal: 'center' };
      const b = ws.getCell(`B${r}`);
      b.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
      b.dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${targets.join(',')}"`],
        showErrorMessage: true,
        error: '请从下拉列表选择「加到多少」，例如 35',
      };
      const c = ws.getCell(`C${r}`);
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
      c.dataValidation = { type: 'list', allowBlank: true, formulae: ['"确认"'], showErrorMessage: true, error: '请选择「确认」' };
      ws.getCell(`D${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED_LIGHT } };
    }
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
