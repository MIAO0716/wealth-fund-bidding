/** CSV / Excel 首轮模板解析：只做格式转换，不做业务纠正，校验统一交给 imports.validateRows */

import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { bizError } from '../lib/errors';
import type { SourcedRow } from './imports';

type Field = 'projectCode' | 'unitCode' | 'unitName' | 'baseTargetWan' | 'firstRoundIncreasePp' | 'remark';

const HEADER_ALIASES: Record<string, Field> = {
  项目: 'projectCode',
  projectcode: 'projectCode',
  单位代码: 'unitCode',
  unitcode: 'unitCode',
  单位名称: 'unitName',
  单位: 'unitName',
  unitname: 'unitName',
  '基础底标(万元)': 'baseTargetWan',
  基础底标: 'baseTargetWan',
  basetargetwan: 'baseTargetWan',
  '首轮增幅(百分点)': 'firstRoundIncreasePp',
  首轮增幅: 'firstRoundIncreasePp',
  firstroundincreasepp: 'firstRoundIncreasePp',
  备注: 'remark',
  remark: 'remark',
};

function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .replace(/^﻿/, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function mapHeaders(headers: unknown[]): Map<number, Field> {
  const map = new Map<number, Field>();
  headers.forEach((h, i) => {
    const f = HEADER_ALIASES[normalizeHeader(h)];
    if (f && ![...map.values()].includes(f)) map.set(i, f);
  });
  const required: Field[] = ['projectCode', 'unitCode', 'baseTargetWan', 'firstRoundIncreasePp'];
  const missing = required.filter((f) => ![...map.values()].includes(f));
  if (missing.length) {
    throw bizError(
      'BAD_REQUEST',
      '模板表头不正确，应为：项目、单位代码、单位名称、基础底标（万元）、首轮增幅（百分点）、备注',
    );
  }
  return map;
}

/** 文本单元格中的增幅：纯整数/小数文本转为数字，其余（如 "30%"）原样保留以便报错 */
function ppFromText(s: string): unknown {
  const t = s.trim();
  if (t === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function isBlankRow(r: SourcedRow): boolean {
  return [r.baseTargetWan, r.firstRoundIncreasePp, r.remark].every((v) => v === null || v === undefined || v === '');
}

export interface ParsedFile {
  rows: SourcedRow[];
  /** 底标、增幅、备注均为空的模板行被跳过的数量（逐批补齐时用） */
  skippedBlank: number;
}

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Windows 版 Excel「CSV（逗号分隔）」默认 GBK 编码
    return iconv.decode(buf, 'gb18030');
  }
}

export function parseCsvBuffer(buf: Buffer): ParsedFile {
  const text = decodeText(buf);
  let records: string[][];
  try {
    records = parseCsv(text, { skip_empty_lines: true, relax_column_count: true, bom: true }) as string[][];
  } catch (e) {
    throw bizError('BAD_REQUEST', `CSV 解析失败：${(e as Error).message}`);
  }
  if (records.length < 1) throw bizError('BAD_REQUEST', 'CSV 文件为空');
  const headerMap = mapHeaders(records[0]);
  const rows: SourcedRow[] = [];
  let skippedBlank = 0;
  records.slice(1).forEach((rec, i) => {
    const row: SourcedRow = { sourceRow: i + 2 };
    for (const [col, field] of headerMap) {
      const v = (rec[col] ?? '').trim();
      if (field === 'firstRoundIncreasePp') row[field] = ppFromText(v);
      else row[field] = v === '' ? null : v;
    }
    if (rec.every((c) => String(c).trim() === '')) return;
    if (isBlankRow(row)) {
      skippedBlank++;
      return;
    }
    rows.push(row);
  });
  return { rows, skippedBlank };
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('result' in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return (v as ExcelJS.CellHyperlinkValue).text;
    return String(v);
  }
  return v;
}

/** 数字单元格转十进制字符串，不引入浮点尾差（如 100.1 → "100.1"） */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(6).replace(/\.?0+$/, '');
}

export async function parseXlsxBuffer(buf: Buffer): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw bizError('BAD_REQUEST', '无法读取 Excel 文件，请使用 .xlsx 格式（不支持旧版 .xls）');
  }
  const ws = wb.getWorksheet('首轮数据') ?? wb.worksheets[0];
  if (!ws) throw bizError('BAD_REQUEST', 'Excel 中没有工作表');
  // 在前 5 行内寻找表头
  let headerRowNo = 0;
  let headerMap: Map<number, Field> | null = null;
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const values: unknown[] = [];
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellValue(cell);
    });
    try {
      headerMap = mapHeaders(values);
      headerRowNo = r;
      break;
    } catch {
      // 继续找
    }
  }
  if (!headerMap) mapHeaders([]); // 抛出表头错误
  const rows: SourcedRow[] = [];
  let skippedBlank = 0;
  for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
    const excelRow = ws.getRow(r);
    const row: SourcedRow = { sourceRow: r };
    let anyValue = false;
    for (const [col, field] of headerMap!) {
      const cell = excelRow.getCell(col + 1);
      let v = cellValue(cell);
      if (typeof v === 'string') v = v.trim();
      if (v !== null && v !== '') anyValue = true;
      if (field === 'baseTargetWan') {
        row[field] = typeof v === 'number' ? numberToDecimalString(v) : v === '' ? null : v;
      } else if (field === 'firstRoundIncreasePp') {
        // 百分比格式单元格（0.3 显示为 30%）原样传给校验，提示「请填 30」
        row[field] = typeof v === 'string' ? ppFromText(v) : v;
      } else {
        row[field] = v === null || v === '' ? null : String(v);
      }
    }
    if (!anyValue) continue;
    if (isBlankRow(row)) {
      skippedBlank++;
      continue;
    }
    rows.push(row);
  }
  return { rows, skippedBlank };
}

export async function parseUpload(fileName: string, buf: Buffer): Promise<ParsedFile & { source: 'CSV' | 'XLSX' }> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return { ...parseCsvBuffer(buf), source: 'CSV' };
  if (lower.endsWith('.xlsx')) return { ...(await parseXlsxBuffer(buf)), source: 'XLSX' };
  if (lower.endsWith('.xls')) throw bizError('BAD_REQUEST', '不支持旧版 .xls，请在 Excel 中另存为 .xlsx');
  throw bizError('BAD_REQUEST', '仅支持 .xlsx 或 .csv 文件');
}
