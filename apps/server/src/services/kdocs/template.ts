/**
 * 金山表格模板（.xlsx）：导入金山文档后即得到单位工作表 + 使用说明，版式与程序读写位置一致。
 * 极简版式：A、B 两列，领导只填黄色的「我要加到」一个格子；信息区内容由程序读取时写入，模板中留空。
 */

import { GROUPS, KDOCS_LAYOUT, UNITS, type UnitDef } from '@bidding/shared';
import { buildZip } from '../../lib/zip';
import ExcelJS from 'exceljs';

/** 版式配色（RGB），与现场大屏的红金配色一致；脚本写入格式与模板共用 */
export const KDOCS_COLORS = {
  red: 'B91C1C',
  white: 'FFFFFF',
  label: '6B7280',
  labelFill: 'FAF6F0',
  text: '1F2329',
  gold: 'A16207',
  inputFill: 'FFF1B8',
  muted: '9CA3AF',
} as const;
const argb = (rgb: string) => `FF${rgb}`;
const RED = argb(KDOCS_COLORS.red);

/**
 * units：本文件包含哪些单位的工作表（默认 16 家，即「一个文件 16 张工作表」；传一家即该单位的独立文件）。
 * hub：总控文件（只放说明，用于存放同步脚本，只有工作人员能打开）。
 */
export async function buildKdocsTemplate(opts: {
  title: string;
  units?: ReadonlyArray<UnitDef>;
  hub?: boolean;
}): Promise<Buffer> {
  const { title } = opts;
  const units = opts.hub ? [] : (opts.units ?? UNITS);
  const perUnit = !opts.hub && units.length === 1;
  const L = KDOCS_LAYOUT;
  const C = KDOCS_COLORS;
  const wb = new ExcelJS.Workbook();
  wb.creator = '理财、基金现场竞标系统';

  const solid = (rgb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: argb(rgb) } });
  for (const u of units) {
    const ws = wb.addWorksheet(u.name, { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 12.5 }, { width: 34 }];
    const group = GROUPS.find((g) => g.groupNo === u.groupNo)!;

    const a1 = ws.getCell('A1');
    a1.value = u.name;
    a1.font = { bold: true, size: 18, color: { argb: argb(C.white) } };
    const b1 = ws.getCell('B1');
    b1.value = `${group.name} · ${title}`;
    b1.font = { size: 11, color: { argb: argb(C.white) } };
    b1.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
    for (const c of [a1, b1]) c.fill = solid(C.red);
    a1.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 36;

    L.labels.forEach((label, i) => {
      const r = 2 + i;
      const a = ws.getCell(`A${r}`);
      a.value = label;
      a.font = { size: 12, color: { argb: argb(C.label) } };
      a.fill = solid(C.labelFill);
      a.alignment = { vertical: 'middle' };
      const b = ws.getCell(`B${r}`);
      b.font = { size: 14, bold: true, color: { argb: argb(C.text) } };
      b.alignment = { vertical: 'middle', wrapText: true };
      if (r <= 5) ws.getRow(r).height = 26;
    });
    ws.getCell('B4').font = { size: 18, bold: true, color: { argb: RED } };
    ws.getCell('B5').font = { size: 14, bold: true, color: { argb: argb(C.gold) } };

    ws.getCell(`A${L.inputRow}`).font = { size: 14, bold: true, color: { argb: RED } };
    const input = ws.getCell(L.inputCell);
    input.fill = solid(C.inputFill);
    input.font = { size: 22, bold: true, color: { argb: RED } };
    input.alignment = { horizontal: 'center', vertical: 'middle' };
    input.border = { top: { style: 'medium', color: { argb: RED } }, bottom: { style: 'medium', color: { argb: RED } }, left: { style: 'medium', color: { argb: RED } }, right: { style: 'medium', color: { argb: RED } } };
    input.dataValidation = {
      type: 'whole',
      operator: 'between',
      allowBlank: true,
      formulae: [1, 300],
      showErrorMessage: true,
      errorTitle: '请填写数字',
      error: '请填写「加到多少」的数字，例如 40',
      showInputMessage: true,
      promptTitle: '我要加到',
      prompt: '填一个数字（如 40），填好后告诉工作人员',
    };
    ws.getRow(L.inputRow).height = 44;
    ws.getCell(L.resultCell).font = { size: 13, bold: true, color: { argb: argb(C.text) } };
    ws.getRow(7).height = 40;
    const note = ws.getCell(L.noteCell);
    note.value = L.note;
    note.font = { size: 11, color: { argb: argb(C.label) } };
    ws.getRow(8).height = 48;
    ws.getCell(L.syncCell).font = { size: 11, color: { argb: argb(C.muted) } };
  }
  // 使用说明（放在最后：领导打开文件时直接看到本单位的表）
  const guide = wb.addWorksheet('使用说明');
  guide.getColumn(1).width = 110;
  const hubLines = [
    `${title} · 竞标总控（只有工作人员能打开，不要分享给领导）`,
    '',
    '本文件只用来存放同步脚本：',
    '1. 在本文件中打开 AirScript 脚本编辑器，新建共享脚本，粘贴管理端下载的同步脚本全文，保存。',
    '2. 在脚本编辑器的「服务」中添加「云文档API」（脚本需要打开 16 家单位的文件）。',
    '3. 生成「脚本令牌」，复制脚本的 webhook 链接。',
    '4. 在管理端「金山文档」中粘贴 webhook 链接、令牌，以及 16 家单位文件的链接，点「一键连接」。',
    '',
    '16 家单位的文件分别只分享给对应单位的领导（可编辑），各单位互相看不到。',
  ];
  const lines = opts.hub ? hubLines : [
    `${title} · 金山文档填报表${perUnit ? `（${units[0].name}）` : ''}`,
    '',
    '【领导】只需要做一件事：',
    `1. 打开本单位的表格${perUnit ? '' : '（工作表名即单位名称）'}，轮到本组时，在黄色的「我要加到」格子（${L.inputCell}）填一个数字，例如 40。`,
    '2. 填好后告诉工作人员，工作人员读取后：「处理结果」显示「✔ 已生效」即成功，黄色格子自动清空；「✘ 未生效」会写明原因，按提示重新填写即可。',
    '3. 「可以加到」一栏列出本次可选的数值；填的是「加到多少」，只增不减。',
    '4. 本专场第一次填写即视为确认认领本专场底标。',
    '',
    '【工作人员】',
    ...(perUnit
      ? [
          `1. 本文件只分享给${units[0].name}领导（可编辑），不要分享给其他单位。不要改工作表名称、不要插入或删除行列。`,
          `2. 建议设置区域权限：领导只能编辑 ${L.inputCell}（黄色格子），其余单元格只读。`,
          '3. 复制本文件的分享链接，填到管理端「金山文档」的单位文件清单中。详细步骤见《金山文档接入说明》。',
        ]
      : [
          '1. 只保留本说明表和 16 张单位工作表，不要改表名、不要插入或删除行列。',
          '2. 注意：同一文件中的工作表互相可见；如需各单位互相看不到，请改用「每家单位一个文件」。',
          `3. 为每张单位工作表设置区域权限：该单位领导只能编辑 ${L.inputCell}（黄色格子），其余单元格只读。`,
          '4. 在本文件中打开 AirScript 脚本编辑器，粘贴管理端下载的脚本，生成脚本令牌，复制 webhook 链接。详细步骤见《金山文档接入说明》。',
        ]),
  ];
  lines.forEach((t, i) => {
    const c = guide.getCell(`A${i + 1}`);
    c.value = t;
    if (i === 0) c.font = { bold: true, size: 14, color: { argb: RED } };
    else if (t.startsWith('【')) c.font = { bold: true };
  });

  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** 每家单位一个文件：16 个单位文件 + 竞标总控，打包成 zip */
export async function buildKdocsTemplateZip(opts: { title: string }): Promise<Buffer> {
  const files: Array<{ name: string; data: Buffer }> = [
    { name: '00-竞标总控（只给工作人员）.xlsx', data: await buildKdocsTemplate({ ...opts, hub: true }) },
  ];
  for (const u of UNITS) {
    files.push({ name: `${String(u.displayOrder).padStart(2, '0')}-${u.name}.xlsx`, data: await buildKdocsTemplate({ ...opts, units: [u] }) });
  }
  return buildZip(files);
}
