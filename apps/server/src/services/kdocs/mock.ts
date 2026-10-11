/**
 * 模拟金山文档：不需要金山账号即可演练完整流程。
 *
 * - 内存中的工作簿（每个模拟文件若干工作表），实现 AirScript 中脚本用到的那部分 API；
 * - sync_task 接口与金山文档相同（请求头 AirScript-Token、请求体 { Context: { argv } }、返回 { status, error, data: { result } }），
 *   并且执行的就是管理端提供下载的同一份 AirScript 源码；
 * - 配套网页 /mock-kdocs 模拟领导在表格中填写（只允许填写领导可编辑的单元格）。
 * 数据只在内存中，程序重启后清空。
 */

import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { KDOCS_LAYOUT, UNITS, bidRowRange } from '@bidding/shared';
import { AIRSCRIPT_SOURCE } from './airscript';

type Cell = string | number | boolean | null;

// ---------------------------------------------------------------- 单元格地址

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseRange(addr: string): { r1: number; c1: number; r2: number; c2: number } {
  const m = /^([A-Za-z]{1,3})(\d{1,6})(?::([A-Za-z]{1,3})(\d{1,6}))?$/.exec(addr.trim());
  if (!m) throw new Error(`无效的单元格地址：${addr}`);
  const c1 = colToNum(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? colToNum(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}

// ---------------------------------------------------------------- 工作簿

class MockSheet {
  readonly cells = new Map<string, Cell>();
  constructor(public Name: string) {}

  get(r: number, c: number): Cell {
    return this.cells.get(`${r},${c}`) ?? null;
  }

  set(r: number, c: number, v: Cell): void {
    if (v === null || v === undefined || v === '') this.cells.delete(`${r},${c}`);
    else this.cells.set(`${r},${c}`, v);
  }

  read(addr: string): Cell[][] {
    const { r1, c1, r2, c2 } = parseRange(addr);
    const out: Cell[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: Cell[] = [];
      for (let c = c1; c <= c2; c++) row.push(this.get(r, c));
      out.push(row);
    }
    return out;
  }

  /** 与 AirScript 一致：单元格区域赋二维数组；赋单个值时整个区域填同一个值 */
  write(addr: string, value: unknown): void {
    const { r1, c1, r2, c2 } = parseRange(addr);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = Array.isArray(value) ? (value as unknown[][])[r - r1]?.[c - c1] : value;
        this.set(r, c, normalizeCell(v));
      }
    }
  }

  /** AirScript 的 Range 对象（只实现脚本用到的部分） */
  Range(addr: string) {
    const sheet = this;
    const single = (() => {
      const p = parseRange(addr);
      return p.r1 === p.r2 && p.c1 === p.c2;
    })();
    return {
      get Value2() {
        const v = sheet.read(addr);
        return single ? v[0][0] : v;
      },
      get Value() {
        const v = sheet.read(addr);
        return single ? v[0][0] : v;
      },
      set Value(v: unknown) {
        sheet.write(addr, v);
      },
    };
  }
}

function normalizeCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

export class MockWorkbook {
  readonly sheets: MockSheet[] = [];
  /** 报价行数（与管理端配置一致，决定模拟页面显示与可编辑范围） */
  maxRows: number = KDOCS_LAYOUT.defaultBidRows;
  constructor(readonly fileId: string) {}

  sheet(name: string): MockSheet | undefined {
    return this.sheets.find((s) => s.Name === name);
  }

  addSheet(name: string): MockSheet {
    const existing = this.sheet(name);
    if (existing) return existing;
    const s = new MockSheet(name);
    this.sheets.push(s);
    return s;
  }

  /** AirScript 的 Application 对象（只实现脚本用到的部分） */
  application() {
    const sheets = this.sheets;
    const item = (i: number | string) => {
      const s = typeof i === 'number' ? sheets[i - 1] : sheets.find((x) => x.Name === i);
      if (!s) throw new Error(`工作表不存在：${i}`);
      return s;
    };
    return {
      Sheets: {
        get Count() {
          return sheets.length;
        },
        Item: item,
      },
    };
  }
}

// ---------------------------------------------------------------- 模拟服务

export interface MockCallResult {
  httpStatus: number;
  body: unknown;
}

export class KdocsMock {
  readonly token: string;
  private files = new Map<string, MockWorkbook>();
  /** 测试用：模拟网络延迟与故障 */
  delayMs = 0;
  failNext = 0;
  /** 以 JSON 字符串形式返回 result（金山文档可能如此） */
  stringifyResult = true;

  constructor(token?: string) {
    this.token = token ?? `mock-${randomBytes(12).toString('hex')}`;
  }

  file(fileId: string): MockWorkbook | undefined {
    return this.files.get(fileId);
  }

  /** 新建模拟文件：每家单位一张空工作表 + 一张说明表（units 为空时只建说明表，作为「总控」文件） */
  createFile(fileId: string, units: ReadonlyArray<{ name: string }> = UNITS): MockWorkbook {
    const wb = new MockWorkbook(fileId);
    wb.addSheet('使用说明').write('A1', units.length ? '模拟金山文档：表格版式由管理端「初始化表格」写入' : '模拟金山文档：竞标总控（只有工作人员能打开，存放同步脚本）');
    for (const u of units) wb.addSheet(u.name);
    this.files.set(fileId, wb);
    return wb;
  }

  /** KSDrive.openFile：模拟文件链接为 mock://文件编号 */
  openByUrl(url: unknown): MockWorkbook {
    const m = typeof url === 'string' ? /^mock:\/\/([A-Za-z0-9_-]+)$/.exec(url) : null;
    const wb = m ? this.files.get(m[1]) : undefined;
    if (!wb) throw new Error(`文件不存在或无权限：${String(url)}`);
    return wb;
  }

  /** 执行 sync_task：校验令牌，运行同一份 AirScript 源码 */
  async syncTask(fileId: string, token: string | undefined, body: unknown): Promise<MockCallResult> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      return { httpStatus: 503, body: { error: '模拟：服务暂不可用' } };
    }
    if (token !== this.token) return { httpStatus: 401, body: { error: 'AirScript-Token 无效' } };
    const wb = this.files.get(fileId);
    if (!wb) return { httpStatus: 404, body: { error: '文件不存在' } };
    const argv = (body as { Context?: { argv?: unknown } } | null)?.Context?.argv ?? {};
    const logs: string[] = [];
    try {
      const result = runAirScript(wb, argv, logs, (url) => this.openByUrl(url));
      return {
        httpStatus: 200,
        body: { status: 'finished', error: '', data: { result: this.stringifyResult ? JSON.stringify(result) : result, logs } },
      };
    } catch (e) {
      return {
        httpStatus: 200,
        body: { status: 'finished', error: String((e as Error).message ?? e), error_details: { msg: String((e as Error).message ?? e) }, data: { result: null, logs } },
      };
    }
  }

  /** 模拟领导在表格中填写：只允许领导可编辑的单元格（B11、报价行的 B/C 列） */
  editCell(fileId: string, sheetName: string, addr: string, value: unknown): void {
    const wb = this.files.get(fileId);
    if (!wb) throw new Error('模拟文件不存在');
    const maxRows = wb.maxRows;
    const sheet = wb.sheet(sheetName);
    if (!sheet) throw new Error('工作表不存在');
    const { r1, c1, r2, c2 } = parseRange(addr);
    if (r1 !== r2 || c1 !== c2) throw new Error('一次只能编辑一个单元格');
    const { first, last } = bidRowRange(maxRows);
    const editable = (r1 === KDOCS_LAYOUT.ackRow && c1 === 2) || (r1 >= first && r1 <= last && (c1 === 2 || c1 === 3));
    if (!editable) throw new Error('该单元格受保护，领导不能编辑');
    sheet.set(r1, c1, normalizeCell(typeof value === 'string' ? value.slice(0, 50) : value));
  }

  /** 网页展示：每张工作表 A1:E{最后一行} */
  snapshot(fileId: string) {
    const wb = this.files.get(fileId);
    if (!wb) return null;
    const maxRows = wb.maxRows;
    const last = bidRowRange(maxRows).last;
    return {
      fileId,
      maxRows,
      sheets: wb.sheets.map((s) => ({ name: s.Name, cells: s.read(`A1:E${last}`) })),
    };
  }
}

const compiled = new vm.Script(`(function () {\n${AIRSCRIPT_SOURCE}\n})()`, { filename: 'airscript.js' });

/** 在隔离环境中运行 AirScript 源码 */
export function runAirScript(wb: MockWorkbook, argv: unknown, logs: string[] = [], openFile?: (url: unknown) => MockWorkbook): unknown {
  const sandbox = {
    Application: wb.application(),
    KSDrive: {
      openFile: (url: unknown) => {
        if (!openFile) throw new Error('KSDrive 不可用');
        const other = openFile(url);
        return { Application: other.application(), close: () => {} };
      },
    },
    Context: { argv: JSON.parse(JSON.stringify(argv ?? {})) },
    console: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
  };
  const out = compiled.runInNewContext(sandbox, { timeout: 2000 });
  // 跨上下文对象转为普通 JSON
  return JSON.parse(JSON.stringify(out));
}
