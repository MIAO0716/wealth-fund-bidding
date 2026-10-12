/** 空白首轮数据模板（32 行，底标与增幅留空，不含任何演示数值） */

import { PROJECT_CODES, PROJECT_NAMES, UNITS } from '@bidding/shared';
import ExcelJS from 'exceljs';

export const TEMPLATE_HEADERS = ['项目', '单位代码', '单位名称', '基础底标（万元）', '首轮增幅（百分点）', '备注'];

function blankRows(): string[][] {
  const rows: string[][] = [];
  for (const p of PROJECT_CODES) for (const u of UNITS) rows.push([PROJECT_NAMES[p], u.code, u.name, '', '', '']);
  return rows;
}

export function templateCsv(): Buffer {
  const lines = [TEMPLATE_HEADERS, ...blankRows()].map((r) => r.join(','));
  // UTF-8 BOM，保证 Excel 直接打开不乱码
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

export async function templateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '现场竞标系统';
  const ws = wb.addWorksheet('首轮数据', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: TEMPLATE_HEADERS[0], key: 'p', width: 8 },
    { header: TEMPLATE_HEADERS[1], key: 'c', width: 10 },
    { header: TEMPLATE_HEADERS[2], key: 'n', width: 10 },
    { header: TEMPLATE_HEADERS[3], key: 'b', width: 18, style: { numFmt: '0.00####' } },
    { header: TEMPLATE_HEADERS[4], key: 'pp', width: 18, style: { numFmt: '0' } },
    { header: TEMPLATE_HEADERS[5], key: 'r', width: 30, style: { numFmt: '@' } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of blankRows()) ws.addRow([r[0], r[1], r[2], null, null, null]);

  const help = wb.addWorksheet('填写说明');
  help.columns = [{ width: 100 }];
  [
    '填写说明',
    '1. 「项目」填 理财 或 基金；「单位代码」不要修改，系统按代码识别单位，名称仅用于核对。',
    '2. 「基础底标（万元）」填正数金额，单位万元，最多 6 位小数（精确到人民币分）。',
    '3. 「首轮增幅（百分点）」填整数百分点：30% 请填 30，不要填 0.3，也不要把单元格设为百分比格式。',
    '4. 增幅必须是整数百分点（如 30 表示 30%），且不低于所在组最低增幅（各组均为 10）；系统不会自动取整或纠正。',
    '5. 可只上传理财 16 行、基金 16 行或全部 32 行；底标与增幅都留空的行会被跳过，可分批补齐。',
    '6. 任意一行有错误时整批不写入，请按提示逐行修改后重新上传。',
  ].forEach((t, i) => {
    const row = help.addRow([t]);
    if (i === 0) row.font = { bold: true };
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
