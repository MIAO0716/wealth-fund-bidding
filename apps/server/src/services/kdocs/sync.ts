/**
 * 金山文档同步：每隔几秒调用一次 AirScript，读取各单位工作表中领导填写的内容，
 * 按与手机端完全相同的规则处理（submitBid / acknowledgeBase），再把结果写回表格。
 *
 * 关键约定（详见《金山文档接入说明》）：
 * - 每个报价行只处理一次（kdocs_rows），之后对该行的修改无效；以本机读取到该行的时间为准。
 * - 领导填写的是「加到多少」（绝对值），重复提交同一值不会重复加码，填低了不会调减。
 * - 首次开启同步时，表格里已有的报价行标记为「开始同步前已填写」，不参与竞标（便于反复演练）。
 * - 认领底标：每个专场首轮发布后，程序先清空 B11 并提示确认，之后读到「确认」才记为认领，
 *   避免上一专场的「确认」被误用到下一专场。
 * - 结束本组、暂停、锁定之前，管理端会先触发一次立即同步（flush），把最后几秒的填写读进来。
 */

import {
  GROUP_BY_NO,
  type KdocsWrite,
  KDOCS_LAYOUT,
  PROJECT_NAMES,
  type ProjectCode,
  UNITS,
  type UnitDef,
  bidRowRange,
  checkBidTarget,
  isBlankCell,
  isConfirmCell,
  kdocsReadRange,
  normalizeAllowedSteps,
  parseTargetCell,
} from '@bidding/shared';
import { withSnapshot } from '../../db/pool';
import { BizError } from '../../lib/errors';
import { submitBid } from '../bids';
import type { Actor } from '../core';
import type { AppContext } from '../context';
import { readConfig } from '../events';
import { acknowledgeBase } from '../projects';
import { bidderMe } from '../views';
import { type CallOptions, KdocsError, callScript } from './client';

export interface KdocsBindingRow {
  event_id: string;
  webhook_url: string;
  token: string;
  interval_sec: number;
  max_rows: number;
  enabled: boolean;
  baseline_done: boolean;
  enabled_at: Date | null;
  updated_at: Date;
  /** 每家单位一个文件：单位代码 → 文件链接；为空表示一个文件 16 张工作表 */
  unit_files: Record<string, string> | null;
}

export interface KdocsStatus {
  enabled: boolean;
  state: 'STOPPED' | 'RUNNING' | 'ERROR' | 'READ_ONLY';
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  calls: number;
  failures: number;
  missingUnits: string[];
  /** 打不开的单位文件等提示 */
  unitErrors: string[];
  baselineDone: boolean;
}

type MeSnapshot = Awaited<ReturnType<typeof bidderMe>>;
interface MeProject {
  status: string;
  groupStatus: string;
  baseTargetWan: string | null;
  firstRoundPp: number | null;
  currentPp: number | null;
  currentTargetWan: string | null;
  bidVersion: number | null;
  baseAcknowledged: boolean;
  baseAcknowledgedAt: string | null;
}

interface ConsumedRow {
  status: 'APPLIED' | 'REJECTED' | 'PREEXISTING';
  targetRaw: string;
  confirmRaw: string;
  message: string;
  seenAt: Date;
}

const TIME_FMT = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtTime = (d: Date | string) => TIME_FMT.format(typeof d === 'string' ? new Date(d) : d);
const rawText = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function kdocsActor(unit: UnitDef): Actor {
  return { type: 'LEADER', id: unit.code, name: `${unit.name}领导（金山文档）`, unitCode: unit.code };
}

/** 信息区「状态」一栏 */
export function statusText(p: MeProject): string {
  switch (p.status) {
    case 'DRAFT':
      return '等待首轮发布';
    case 'ROUND1_PUBLISHED':
      return '首轮已发布，等待开始';
    case 'PAUSED':
      return '已暂停，请等待工作人员';
    case 'LOCKED':
      return '本专场已结束（结果已锁定）';
    case 'LIVE':
      if (p.groupStatus === 'OPEN') return '本组竞标中，可以报价';
      if (p.groupStatus === 'CLOSED') return '本组已结束';
      return '竞标中，尚未轮到本组';
    default:
      return p.status;
  }
}

/** 下一步可选的「加到」数值 */
export function nextTargets(p: MeProject, steps: readonly number[], groupMinPp: number): number[] {
  if (p.status !== 'LIVE' || p.groupStatus !== 'OPEN' || !p.baseAcknowledged || p.currentPp === null) return [];
  const out: number[] = [];
  for (const s of steps) {
    const t = p.currentPp + s;
    if (checkBidTarget({ currentPp: p.currentPp, targetPp: t, allowedSteps: steps, groupMinPp }).ok) out.push(t);
  }
  return out;
}

class EventSync {
  binding: KdocsBindingRow;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private callNo = 0;
  /** 已成功写入表格的内容：key = 表名!区域 */
  private written = new Map<string, string>();
  /** 期望表格呈现的内容（每轮处理后重新计算） */
  private desired = new Map<string, KdocsWrite>();
  /** 只写一次的指令（清空 B11 等） */
  private oneShot: Array<{ write: KdocsWrite; onSent?: (callNo: number) => void }> = [];
  /** 认领底标提示：已为哪个专场清空过 B11，以及清空指令随哪次调用发出 */
  private ackPrompt = new Map<string, { project: ProjectCode; sentCall: number | null }>();
  private ackErrors = new Map<string, string>();
  private consumed: Map<string, ConsumedRow> | null = null;
  private lastSeq = -1;
  private lastStampAt = 0;
  private dirty = true;
  readonly status: KdocsStatus;

  constructor(
    private readonly ctx: AppContext,
    binding: KdocsBindingRow,
    private readonly callOpts: CallOptions,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    this.binding = binding;
    this.status = {
      enabled: binding.enabled,
      state: 'RUNNING',
      lastOkAt: null,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      lastDurationMs: null,
      calls: 0,
      failures: 0,
      missingUnits: [],
      unitErrors: [],
      baselineDone: binding.baseline_done,
    };
  }

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status.state = 'STOPPED';
  }

  /** 表格被重新初始化后：忘记已写入的内容，下一轮全部重写 */
  resetWritten(): void {
    this.written.clear();
    this.dirty = true;
  }

  /** 立即执行一轮（排在正在进行的一轮之后） */
  syncNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.chain.then(() => this.cycle());
    this.chain = run.catch(() => {});
    return run.finally(() => this.schedule(this.nextDelay()));
  }

  private nextDelay(): number {
    const base = this.binding.interval_sec * 1000;
    const f = this.status.consecutiveFailures;
    return f === 0 ? base : Math.min(base * 2 ** Math.min(f, 5), 60_000);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = this.chain.then(() => this.cycle());
      this.chain = run.catch(() => {});
      run.catch(() => {}).finally(() => this.schedule(this.nextDelay()));
    }, ms);
  }

  // ------------------------------------------------------------ 一轮同步

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    if (this.ctx.config.readOnly) {
      this.status.state = 'READ_ONLY';
      return;
    }
    const started = Date.now();
    const eventId = this.binding.event_id;
    const maxRows = this.binding.max_rows;
    try {
      if (!this.consumed) this.consumed = await this.loadConsumed();

      // 1. 读取各单位填写区（顺带补写上一轮未成功写入的内容）
      const reads = UNITS.map((u) => ({ ...this.target(u), range: kdocsReadRange(maxRows) }));
      const { result, callNo } = await this.send(reads);
      if (result.errors?.length) this.log(`金山文档脚本报告：${result.errors.slice(0, 3).join('；')}`);

      const grids = new Map<string, unknown[][]>();
      const unitErrors: string[] = [];
      for (const r of result.reads ?? []) {
        if (r.values) grids.set(r.sheet, r.values);
        else if (r.error) unitErrors.push(`${r.sheet}：${r.error}`);
      }
      this.status.missingUnits = UNITS.filter((u) => !grids.has(u.name)).map((u) => u.name);
      this.status.unitErrors = unitErrors.slice(0, 5);

      // 2. 首次开启：已有内容标记为「开始同步前已填写」
      if (!this.binding.baseline_done) {
        await this.markBaseline(grids);
      } else {
        // 3. 认领底标与报价行
        for (const unit of UNITS) {
          const grid = grids.get(unit.name);
          if (!grid) continue;
          await this.processUnit(unit, grid, callNo);
        }
      }

      // 4. 计算并立即写回处理结果、信息区（无变化时不调用）
      await this.computeDesired(grids);
      if (this.oneShot.length || this.pendingWrites().length) await this.send([]);

      this.status.state = 'RUNNING';
      this.status.lastOkAt = new Date().toISOString();
      this.status.consecutiveFailures = 0;
      this.status.lastDurationMs = Date.now() - started;
    } catch (e) {
      this.status.state = 'ERROR';
      this.status.failures++;
      this.status.consecutiveFailures++;
      this.status.lastError = e instanceof KdocsError || e instanceof BizError ? e.message : `同步出错：${(e as Error).message}`;
      this.status.lastErrorAt = new Date().toISOString();
      this.status.lastDurationMs = Date.now() - started;
      if (!(e instanceof KdocsError)) this.log(`金山文档同步出错（活动 ${eventId}）`, e);
      throw e;
    }
  }

  /** 一次脚本调用：先写（一次性指令 + 与上次写入不同的内容），后读 */
  /** 单位工作表所在位置：每家一个文件时带上文件链接 */
  private target(unit: UnitDef): { file?: string; sheet: string } {
    const file = this.binding.unit_files?.[unit.code];
    return file ? { file, sheet: unit.name } : { sheet: unit.name };
  }

  private async send(reads: Array<{ file?: string; sheet: string; range: string }>) {
    const writes = this.pendingWrites();
    const shots = this.oneShot.splice(0);
    let result;
    try {
      result = await callScript(
        this.binding.webhook_url,
        this.binding.token,
        { action: 'batch', writes: [...shots.map((x) => x.write), ...writes.map((w) => w.write)], reads },
        this.callOpts,
      );
    } catch (e) {
      this.oneShot.unshift(...shots);
      throw e;
    }
    if (this.binding.unit_files && result.supportsFiles !== true) {
      throw new KdocsError('脚本版本过旧，不支持「每家单位一个文件」：请从管理端重新下载脚本，在总控文件中整体替换', 'PROTOCOL');
    }
    const callNo = ++this.callNo;
    this.status.calls++;
    for (const w of writes) this.written.set(w.key, w.json);
    for (const x of shots) x.onSent?.(callNo);
    return { result, callNo };
  }

  private pendingWrites(): Array<{ key: string; json: string; write: KdocsWrite }> {
    const out: Array<{ key: string; json: string; write: KdocsWrite }> = [];
    for (const [key, w] of this.desired) {
      const json = JSON.stringify(w.values);
      if (this.written.get(key) !== json) out.push({ key, json, write: w });
    }
    return out;
  }

  private async loadConsumed(): Promise<Map<string, ConsumedRow>> {
    const r = await this.ctx.db.query(
      'SELECT unit_code, row_no, status, target_raw, confirm_raw, message, first_seen_at FROM kdocs_rows WHERE event_id = $1',
      [this.binding.event_id],
    );
    const m = new Map<string, ConsumedRow>();
    for (const row of r.rows) {
      m.set(`${row.unit_code}:${row.row_no}`, {
        status: row.status,
        targetRaw: row.target_raw ?? '',
        confirmRaw: row.confirm_raw ?? '',
        message: row.message,
        seenAt: row.first_seen_at,
      });
    }
    return m;
  }

  private async consume(
    unit: UnitDef,
    rowNo: number,
    target: unknown,
    confirm: unknown,
    rec: { status: ConsumedRow['status']; message: string; projectCode?: string | null; fromPp?: number | null; toPp?: number | null; receiptNo?: string | null },
  ): Promise<void> {
    const r = await this.ctx.db.query(
      `INSERT INTO kdocs_rows (event_id, unit_code, row_no, target_raw, confirm_raw, status, project_code, from_pp, to_pp, receipt_no, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (event_id, unit_code, row_no) DO NOTHING
       RETURNING first_seen_at`,
      [
        this.binding.event_id,
        unit.code,
        rowNo,
        rawText(target),
        rawText(confirm),
        rec.status,
        rec.projectCode ?? null,
        rec.fromPp ?? null,
        rec.toPp ?? null,
        rec.receiptNo ?? null,
        rec.message,
      ],
    );
    this.consumed!.set(`${unit.code}:${rowNo}`, {
      status: rec.status,
      targetRaw: rawText(target),
      confirmRaw: rawText(confirm),
      message: rec.message,
      seenAt: r.rows[0]?.first_seen_at ?? new Date(),
    });
    this.dirty = true;
  }

  private async markBaseline(grids: Map<string, unknown[][]>): Promise<void> {
    for (const unit of UNITS) {
      const grid = grids.get(unit.name);
      if (!grid) continue;
      for (const { rowNo, target, confirm } of bidRows(grid, this.binding.max_rows)) {
        if (this.consumed!.has(`${unit.code}:${rowNo}`)) continue;
        if (isBlankCell(target) && isBlankCell(confirm)) continue;
        await this.consume(unit, rowNo, target, confirm, { status: 'PREEXISTING', message: '开始同步前已填写，未处理' });
      }
    }
    await this.ctx.db.query('UPDATE kdocs_bindings SET baseline_done = true WHERE event_id = $1', [this.binding.event_id]);
    this.binding.baseline_done = true;
    this.status.baselineDone = true;
  }

  private async loadMe(unitCode: string): Promise<MeSnapshot> {
    return withSnapshot(this.ctx.db, (tx) => bidderMe(tx, this.binding.event_id, unitCode));
  }

  private async processUnit(unit: UnitDef, grid: unknown[][], callNo: number): Promise<void> {
    const eventId = this.binding.event_id;
    let me = await this.loadMe(unit.code);
    const project = me.event.currentProject as ProjectCode;
    const p = me.projects[project] as MeProject;

    // 认领底标：只认可清空 B11（与 C11 提示同一次写入）之后读到的「确认」
    if (!p.baseAcknowledged && p.status !== 'DRAFT' && p.status !== 'LOCKED') {
      const prompt = this.ackPrompt.get(unit.code);
      if (prompt && prompt.project === project && prompt.sentCall !== null && callNo > prompt.sentCall && isConfirmCell(grid[0]?.[0])) {
        try {
          await acknowledgeBase(this.ctx, eventId, kdocsActor(unit), project, unit.code, { idempotencyKey: `kdack:${unit.code}:${project}:${eventId.slice(0, 8)}` }, { channel: 'KDOCS' });
          this.ackErrors.delete(unit.code);
        } catch (e) {
          if (!(e instanceof BizError)) throw e;
          this.ackErrors.set(unit.code, e.message);
        }
        this.dirty = true;
        me = await this.loadMe(unit.code);
      }
    }

    // 报价行：按行号顺序，每行只处理一次
    for (const { rowNo, target, confirm } of bidRows(grid, this.binding.max_rows)) {
      if (this.consumed!.has(`${unit.code}:${rowNo}`)) continue;
      if (isBlankCell(target) || !isConfirmCell(confirm)) continue;
      const parsed = parseTargetCell(target);
      if (!parsed.ok) {
        await this.consume(unit, rowNo, target, confirm, { status: 'REJECTED', message: parsed.reason });
        continue;
      }
      const outcome = await this.applyBid(unit, rowNo, parsed.pp);
      await this.consume(unit, rowNo, target, confirm, outcome);
    }
  }

  /** 与手机端同一套规则；幂等键包含行号，程序中断后重试不会重复加码 */
  private async applyBid(unit: UnitDef, rowNo: number, pp: number) {
    const eventId = this.binding.event_id;
    const keyPrefix = `kd:${unit.code}:${rowNo}:`;
    const done = await this.ctx.db.query(
      `SELECT project_code, from_pp, to_pp, receipt_no FROM bid_records WHERE event_id = $1 AND unit_code = $2 AND idempotency_key LIKE $3`,
      [eventId, unit.code, `${keyPrefix}%`],
    );
    if (done.rowCount) {
      const b = done.rows[0];
      return { status: 'APPLIED' as const, message: appliedText(b.from_pp, b.to_pp, b.receipt_no), projectCode: b.project_code, fromPp: b.from_pp, toPp: b.to_pp, receiptNo: b.receipt_no };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const me = await this.loadMe(unit.code);
      const project = me.event.currentProject as ProjectCode;
      const p = me.projects[project] as MeProject;
      if (p.bidVersion === null) {
        return { status: 'REJECTED' as const, message: '当前专场尚未开放', projectCode: project };
      }
      try {
        const r = await submitBid(
          this.ctx,
          eventId,
          kdocsActor(unit),
          project,
          unit.code,
          { targetIncreasePp: pp, expectedBidVersion: p.bidVersion, idempotencyKey: `${keyPrefix}${p.bidVersion}`, confirmHighValue: true },
          { channel: 'KDOCS' },
        );
        const b = r.body;
        return { status: 'APPLIED' as const, message: appliedText(b.fromPp, b.toPp, b.receiptNo), projectCode: project, fromPp: b.fromPp, toPp: b.toPp, receiptNo: b.receiptNo };
      } catch (e) {
        if (!(e instanceof BizError)) throw e;
        if (e.code === 'VERSION_CONFLICT') continue;
        return { status: 'REJECTED' as const, message: e.message, projectCode: project, toPp: pp };
      }
    }
    return { status: 'REJECTED' as const, message: '当前增幅刚被更新，请在下一行重新填写', toPp: pp };
  }

  // ------------------------------------------------------------ 写回内容

  private async computeDesired(grids: Map<string, unknown[][]>): Promise<void> {
    const seqRow = await this.ctx.db.query<{ seq: string }>('SELECT seq FROM events WHERE id = $1', [this.binding.event_id]);
    const seq = Number(seqRow.rows[0]?.seq ?? 0);
    const now = Date.now();
    const stampDue = now - this.lastStampAt >= 30_000;
    if (seq === this.lastSeq && !this.dirty && !stampDue && !this.hasPendingHintsChange(grids)) return;

    const evRow = (await this.ctx.db.query('SELECT * FROM events WHERE id = $1', [this.binding.event_id])).rows[0];
    const cfg = readConfig(evRow);
    const steps = normalizeAllowedSteps(cfg.allowedIncrementSteps) ?? [5];
    const next = new Map<string, KdocsWrite>();
    const { first, last } = bidRowRange(this.binding.max_rows);

    for (const unit of UNITS) {
      if (this.status.missingUnits.includes(unit.name)) continue;
      const me = await this.loadMe(unit.code);
      const project = me.event.currentProject as ProjectCode;
      const p = me.projects[project] as MeProject;
      const group = GROUP_BY_NO.get(unit.groupNo)!;
      const nt = nextTargets(p, steps, group.minIncreasePp);
      const info = [
        unit.name,
        `${group.name}（最低 ${group.minIncreasePp}%）`,
        PROJECT_NAMES[project],
        statusText(p),
        p.baseTargetWan ?? '—',
        p.firstRoundPp !== null ? `${p.firstRoundPp}%` : '—',
        p.currentPp !== null ? `${p.currentPp}%` : '—',
        p.currentTargetWan ?? '—',
        nt.length ? nt.join(' / ') : !p.baseAcknowledged && p.status !== 'DRAFT' ? '请先在 B11 确认认领底标' : '—',
      ];
      put(next, this.target(unit), KDOCS_LAYOUT.infoValueRange, info.map((v) => [v]));

      // 本专场第一次需要认领：清空 B11（与下面的提示同一次写入），之后读到的「确认」才有效
      if (!p.baseAcknowledged && p.status !== 'DRAFT' && p.status !== 'LOCKED') this.ensureAckPrompt(unit, project);

      let ackText: string;
      if (p.status === 'DRAFT') ackText = '首轮发布后再确认';
      else if (p.baseAcknowledged) ackText = `已确认（${PROJECT_NAMES[project]}，${p.baseAcknowledgedAt ? fmtTime(p.baseAcknowledgedAt) : ''}）`;
      else if (this.ackErrors.has(unit.code)) ackText = `未生效：${this.ackErrors.get(unit.code)}`;
      else ackText = `请在 B${KDOCS_LAYOUT.ackRow} 选择「确认」认领${PROJECT_NAMES[project]}底标`;
      put(next, this.target(unit), `C${KDOCS_LAYOUT.ackRow}`, [[ackText]]);

      const grid = grids.get(unit.name);
      const rows = grid ? bidRows(grid, this.binding.max_rows) : [];
      for (let rowNo = first; rowNo <= last; rowNo++) {
        const c = this.consumed!.get(`${unit.code}:${rowNo}`);
        const cur = rows.find((r) => r.rowNo === rowNo);
        let d = '';
        let t = '';
        if (c) {
          const changed = cur && (rawText(cur.target) !== c.targetRaw || rawText(cur.confirm) !== c.confirmRaw);
          d = feedbackText(c) + (changed ? '（此行已处理，之后的修改无效，请在下一行填写）' : '');
          t = fmtTime(c.seenAt);
        } else if (cur && !isBlankCell(cur.target) && !isConfirmCell(cur.confirm)) {
          d = '待确认：请在 C 列选择「确认」后生效';
        }
        const key = `${unit.name}!D${rowNo}:E${rowNo}`;
        if (d || this.written.has(key)) put(next, this.target(unit), `D${rowNo}:E${rowNo}`, [[d, t]]);
      }
    }
    // 同步时间：每 30 秒或有其他变化时更新
    const stamp = fmtTime(new Date());
    for (const unit of UNITS) {
      if (this.status.missingUnits.includes(unit.name)) continue;
      put(next, this.target(unit), `${KDOCS_LAYOUT.syncValueCell}`, [[stamp]]);
    }
    this.lastStampAt = now;
    this.desired = next;
    this.lastSeq = seq;
    this.dirty = false;
    this.lastHints = hintSignature(grids, this.consumed!, this.binding.max_rows);
  }

  private ensureAckPrompt(unit: UnitDef, project: ProjectCode): void {
    const prompt = this.ackPrompt.get(unit.code);
    if (prompt && prompt.project === project) return;
    const entry = { project, sentCall: null as number | null };
    this.ackPrompt.set(unit.code, entry);
    this.ackErrors.delete(unit.code);
    this.oneShot.push({
      write: { ...this.target(unit), range: `B${KDOCS_LAYOUT.ackRow}`, values: [['']] },
      onSent: (n) => {
        entry.sentCall = n;
      },
    });
  }

  private lastHints = '';
  private hasPendingHintsChange(grids: Map<string, unknown[][]>): boolean {
    return hintSignature(grids, this.consumed!, this.binding.max_rows) !== this.lastHints;
  }
}

function put(m: Map<string, KdocsWrite>, at: { file?: string; sheet: string }, range: string, values: unknown[][]): void {
  m.set(`${at.sheet}!${range}`, { ...at, range, values });
}

function appliedText(fromPp: number, toPp: number, receiptNo: string): string {
  return `已生效：${fromPp}% → ${toPp}%（回执 ${receiptNo}）`;
}

function feedbackText(c: ConsumedRow): string {
  if (c.status === 'APPLIED') return `✔ ${c.message}`;
  if (c.status === 'PREEXISTING') return `— ${c.message}`;
  return `✘ 未生效：${c.message}`;
}

/** 读取结果中的报价行：grid 第 0 行对应第 11 行（B11:C11），第 2 行起对应第 13 行起 */
function bidRows(grid: unknown[][], maxRows: number): Array<{ rowNo: number; target: unknown; confirm: unknown }> {
  const out: Array<{ rowNo: number; target: unknown; confirm: unknown }> = [];
  const offset = KDOCS_LAYOUT.firstBidRow - KDOCS_LAYOUT.ackRow;
  for (let i = 0; i < maxRows; i++) {
    const row = grid[offset + i];
    if (!row) break;
    out.push({ rowNo: KDOCS_LAYOUT.firstBidRow + i, target: row[0], confirm: row[1] });
  }
  return out;
}

/** 「待确认」提示只取决于未处理行的填写情况 */
function hintSignature(grids: Map<string, unknown[][]>, consumed: Map<string, ConsumedRow>, maxRows: number): string {
  const parts: string[] = [];
  for (const unit of UNITS) {
    const grid = grids.get(unit.name);
    if (!grid) continue;
    for (const r of bidRows(grid, maxRows)) {
      const c = consumed.get(`${unit.code}:${r.rowNo}`);
      if (c) {
        if (rawText(r.target) !== c.targetRaw || rawText(r.confirm) !== c.confirmRaw) parts.push(`${unit.code}${r.rowNo}x`);
      } else if (!isBlankCell(r.target) && !isConfirmCell(r.confirm)) parts.push(`${unit.code}${r.rowNo}p`);
    }
  }
  return parts.join(',');
}

// ---------------------------------------------------------------- 管理

export class KdocsSyncManager {
  private loops = new Map<string, EventSync>();
  private started = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
    readonly callOpts: CallOptions = {},
  ) {}

  /** 程序启动：恢复所有已开启同步的活动 */
  async start(): Promise<void> {
    this.started = true;
    const r = await this.ctx.db.query<KdocsBindingRow>('SELECT * FROM kdocs_bindings WHERE enabled');
    for (const b of r.rows) this.ensure(b);
  }

  stop(): void {
    this.started = false;
    for (const l of this.loops.values()) l.stop();
    this.loops.clear();
  }

  async binding(eventId: string): Promise<KdocsBindingRow | null> {
    const r = await this.ctx.db.query<KdocsBindingRow>('SELECT * FROM kdocs_bindings WHERE event_id = $1', [eventId]);
    return r.rows[0] ?? null;
  }

  /** 配置变化后调用：开启则启动/更新循环，关闭则停止 */
  async refresh(eventId: string): Promise<void> {
    const b = await this.binding(eventId);
    const existing = this.loops.get(eventId);
    if (!b || !b.enabled) {
      existing?.stop();
      this.loops.delete(eventId);
      return;
    }
    if (
      existing &&
      existing.binding.webhook_url === b.webhook_url &&
      existing.binding.max_rows === b.max_rows &&
      JSON.stringify(existing.binding.unit_files) === JSON.stringify(b.unit_files)
    ) {
      existing.binding = b;
      return;
    }
    existing?.stop();
    this.loops.delete(eventId);
    if (this.started) this.ensure(b);
  }

  private ensure(b: KdocsBindingRow): void {
    if (this.loops.has(b.event_id)) return;
    const loop = new EventSync(this.ctx, b, this.callOpts, this.log);
    this.loops.set(b.event_id, loop);
    loop.start();
  }

  status(eventId: string): KdocsStatus | null {
    return this.loops.get(eventId)?.status ?? null;
  }

  isActive(eventId: string): boolean {
    return this.loops.has(eventId);
  }

  /** 立即同步一轮；未开启时什么也不做 */
  async syncNow(eventId: string): Promise<void> {
    const l = this.loops.get(eventId);
    if (l) await l.syncNow();
  }

  /**
   * 结束本组、暂停、锁定前调用：先把表格中最后的填写读进来。
   * 金山文档不可用时不阻塞现场操作，返回提示文字。
   */
  async flush(eventId: string, timeoutMs = 10_000): Promise<string | null> {
    const l = this.loops.get(eventId);
    if (!l) return null;
    try {
      await Promise.race([
        l.syncNow(),
        new Promise((_, reject) => setTimeout(() => reject(new KdocsError('金山文档同步超时', 'TIMEOUT')), timeoutMs)),
      ]);
      return null;
    } catch (e) {
      return `操作前读取金山文档失败（${(e as Error).message}），最后几秒的填写可能未读入，请核对表格`;
    }
  }

  resetWritten(eventId: string): void {
    this.loops.get(eventId)?.resetWritten();
  }
}
