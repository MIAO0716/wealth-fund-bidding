/**
 * 金山文档同步：工作人员点「读取金山表格」时（或开启自动定时读取时）调用一次 AirScript，读取各单位「我要加到」格子（B6），
 * 按与手机端完全相同的规则处理（submitBid / acknowledgeBase），再把结果写回表格。
 *
 * 关键约定（详见《金山文档接入说明》）：
 * - 读取那一刻 B6 里的数字就是领导的决定；处理后程序清空 B6（条件清空：领导刚好改了就不清，下次读取再处理），结果写在 B7。
 * - 领导填写的是「加到多少」（绝对值），填低了、不在可选范围内都不会生效，B7 写明原因。
 * - 本专场第一次填写即视为确认认领底标（先认领，再按规则加码）。
 * - 首次开启时 B6 里已有的内容标记为「开始读取前已填写」，不参与竞标并清空（便于反复演练）。
 * - 结束本组、暂停、锁定之前，管理端会先触发一次立即读取（flush），把最后几秒的填写读进来。
 */

import {
  GROUP_BY_NO,
  type KdocsWrite,
  KDOCS_LAYOUT,
  PROJECT_NAMES,
  type ProjectCode,
  UNITS,
  type UnitDef,
  checkBidTarget,
  isBlankCell,
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
  /** 自动定时读取（默认关闭：手动点「读取金山表格」） */
  auto_sync: boolean;
}

/** 一次读取的结果摘要 */
export interface KdocsReadSummary {
  at: string;
  applied: number;
  rejected: number;
  acked: number;
  /** 本次有新处理内容的单位 */
  units: string[];
  durationMs: number;
}

/**
 * 按需同步的节奏（减少对金山文档的调用次数）：
 * - HOT  有组正在竞标：按配置的同步间隔（默认 3 秒）
 * - WARM 首轮已发布等待开始、组与组之间、暂停：每 10 秒（认领底标等反馈不至于太慢）
 * - COLD 当前专场首轮尚未发布：每 30 秒
 * - IDLE 理财、基金都已锁定：停止自动同步（「立即同步」仍可用）
 * 现场操作（发布首轮、开始、开放/结束本组、暂停、恢复、锁定）后会立即同步一次，不必等下一轮。
 */
export type KdocsPace = 'HOT' | 'WARM' | 'COLD' | 'IDLE';
export const KDOCS_WARM_MS = 10_000;
export const KDOCS_COLD_MS = 30_000;

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
  /** 当前同步节奏；null 表示尚未判断 */
  pace: KdocsPace | null;
  /** 下一次自动同步的时间；null 表示不再自动同步（手动读取时始终为 null） */
  nextSyncAt: string | null;
  autoSync: boolean;
  /** 最近一次成功读取的结果 */
  lastRead: KdocsReadSummary | null;
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
  rowNo: number;
  /** 清空「我要加到」的指令是否已送达 */
  cleared: boolean;
  status: 'APPLIED' | 'REJECTED' | 'PREEXISTING';
  targetRaw: string;
  message: string;
  seenAt: Date;
}

type Outcome = {
  status: 'APPLIED' | 'REJECTED';
  message: string;
  projectCode?: string | null;
  fromPp?: number | null;
  toPp?: number | null;
  receiptNo?: string | null;
};

const TIME_FMT = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtTime = (d: Date | string) => TIME_FMT.format(typeof d === 'string' ? new Date(d) : d);
const rawText = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const canAck = (p: MeProject) => !p.baseAcknowledged && p.status !== 'DRAFT' && p.status !== 'LOCKED';

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
      if (p.groupStatus === 'OPEN') return '本组竞标中，可以加码';
      if (p.groupStatus === 'CLOSED') return '本组已结束';
      return '竞标中，尚未轮到本组';
    default:
      return p.status;
  }
}

/** 下一步可选的「加到」数值（尚未认领底标时按认领后计算：首次填写即认领） */
export function nextTargets(p: MeProject, steps: readonly number[], groupMinPp: number): number[] {
  if (p.status !== 'LIVE' || p.groupStatus !== 'OPEN' || p.currentPp === null) return [];
  const out: number[] = [];
  for (const s of steps) {
    const t = p.currentPp + s;
    if (checkBidTarget({ currentPp: p.currentPp, targetPp: t, allowedSteps: steps, groupMinPp }).ok) out.push(t);
  }
  return out;
}

/** 没有可选数值时「可以加到」一栏的说明 */
function optionsHint(p: MeProject): string {
  switch (p.status) {
    case 'DRAFT':
      return '首轮发布后可填';
    case 'ROUND1_PUBLISHED':
      return '竞标开始、轮到本组后可填';
    case 'PAUSED':
      return '暂停中，请等待';
    case 'LOCKED':
      return '本专场已结束';
    default:
      return p.groupStatus === 'CLOSED' ? '本组已结束' : '轮到本组后可填';
  }
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
  /** 只写一次的指令（条件清空 B6）；送达后执行 onSent */
  private oneShot: Array<{ write: KdocsWrite; onSent?: (callNo: number) => Promise<void> | void }> = [];
  /** 已处理、但清空 B6 的指令尚未送达的内容：在此期间再读到同一内容不重复处理 */
  private pendingClear = new Map<string, { expect: unknown }>();
  /** 每家单位最近一次处理的记录（序号递增，每次填写一条） */
  private last: Map<string, ConsumedRow> | null = null;
  private stats = { applied: 0, rejected: 0, acked: 0, units: new Set<string>() };
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
      pace: null,
      nextSyncAt: null,
      autoSync: binding.auto_sync,
      lastRead: null,
    };
  }

  /** 开启时读取一次（标记「开始同步前已填写」）；手动模式之后不再自动读取 */
  start(): void {
    if (this.binding.auto_sync || !this.binding.baseline_done) this.schedule(0);
  }

  /** 配置变化（同一张表格）：更新间隔、令牌、自动/手动 */
  rebind(b: KdocsBindingRow): void {
    const wasAuto = this.binding.auto_sync;
    this.binding = b;
    this.status.autoSync = b.auto_sync;
    if (b.auto_sync && !wasAuto) this.schedule(0);
    if (!b.auto_sync && wasAuto) this.schedule(null);
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

  private nextDelay(): number | null {
    // 手动读取：不安排任何自动读取（失败也不自动重试）
    if (!this.binding.auto_sync) return null;
    const base = this.binding.interval_sec * 1000;
    const f = this.status.consecutiveFailures;
    if (f > 0) return Math.min(base * 2 ** Math.min(f, 5), 60_000);
    switch (this.status.pace) {
      case 'IDLE':
        return null;
      case 'COLD':
        return Math.max(base, KDOCS_COLD_MS);
      case 'WARM':
        return Math.max(base, KDOCS_WARM_MS);
      default:
        return base;
    }
  }

  private schedule(ms: number | null): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (ms === null) {
      this.status.nextSyncAt = null;
      return;
    }
    this.status.nextSyncAt = new Date(Date.now() + ms).toISOString();
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
    this.stats = { applied: 0, rejected: 0, acked: 0, units: new Set<string>() };
    try {
      if (!this.last) {
        this.last = await this.loadLast();
        // 程序重启后：上次处理过、清空指令却没送达的内容，先条件清空（仍是那个数才清）
        for (const unit of UNITS) {
          const l = this.last.get(unit.code);
          if (l && !l.cleared && l.targetRaw) this.queueClear(unit, l.targetRaw);
        }
      }

      // 1. 读取各单位「我要加到」（顺带送出上一轮未成功写入的内容；先写后读）
      const reads = UNITS.map((u) => ({ ...this.target(u), range: kdocsReadRange() }));
      const { result } = await this.send(reads);
      if (result.errors?.length) this.log(`金山文档脚本报告：${result.errors.slice(0, 3).join('；')}`);

      const inputs = new Map<string, unknown>();
      const unitErrors: string[] = [];
      for (const r of result.reads ?? []) {
        if (r.values) inputs.set(r.sheet, r.values[0]?.[0] ?? null);
        else if (r.error) unitErrors.push(`${r.sheet}：${r.error}`);
      }
      this.status.missingUnits = UNITS.filter((u) => !inputs.has(u.name)).map((u) => u.name);
      this.status.unitErrors = unitErrors.slice(0, 5);

      // 2. 首次开启：已有内容标记为「开始读取前已填写」；之后逐家处理
      if (!this.binding.baseline_done) {
        await this.markBaseline(inputs);
      } else {
        for (const unit of UNITS) {
          if (inputs.has(unit.name)) await this.processUnit(unit, inputs.get(unit.name));
        }
      }

      // 3. 计算并立即写回处理结果、信息区（无变化时不调用）
      await this.computeDesired();
      if (this.oneShot.length || this.pendingWrites().length) await this.send([]);

      this.status.pace = await this.currentPace();
      this.status.lastRead = {
        at: new Date().toISOString(),
        applied: this.stats.applied,
        rejected: this.stats.rejected,
        acked: this.stats.acked,
        units: UNITS.filter((u) => this.stats.units.has(u.code)).map((u) => u.name),
        durationMs: Date.now() - started,
      };
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

  private async currentPace(): Promise<KdocsPace> {
    const r = await this.ctx.db.query<{ project_code: string; status: string; open: boolean; current: boolean }>(
      `SELECT p.project_code, p.status, p.project_code = e.current_project AS current,
              EXISTS (SELECT 1 FROM project_groups g
                       WHERE g.event_id = p.event_id AND g.project_code = p.project_code AND g.status = 'OPEN') AS open
         FROM projects p JOIN events e ON e.id = p.event_id
        WHERE p.event_id = $1`,
      [this.binding.event_id],
    );
    if (r.rows.length && r.rows.every((x) => x.status === 'LOCKED')) return 'IDLE';
    const cur = r.rows.find((x) => x.current);
    if (!cur) return 'WARM';
    if (cur.status === 'LIVE' && cur.open) return 'HOT';
    if (cur.status === 'DRAFT') return 'COLD';
    return 'WARM';
  }

  /** 单位工作表所在位置：每家一个文件时带上文件链接 */
  private target(unit: UnitDef): { file?: string; sheet: string } {
    const file = this.binding.unit_files?.[unit.code];
    return file ? { file, sheet: unit.name } : { sheet: unit.name };
  }

  /** 一次脚本调用：先写（一次性指令 + 与上次写入不同的内容），后读 */
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
      if (result.supportsExpect !== true) {
        throw new KdocsError('脚本版本过旧（需要 1.3.0 及以上）：请从管理端重新下载脚本，在总控文件中整体替换并保存', 'PROTOCOL');
      }
    } catch (e) {
      this.oneShot.unshift(...shots);
      throw e;
    }
    const callNo = ++this.callNo;
    this.status.calls++;
    for (const w of writes) this.written.set(w.key, w.json);
    await Promise.all(shots.map((x) => x.onSent?.(callNo)));
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

  /** 条件清空 B6：只有格子里仍是 expect 时才清空；送达前再读到同一内容不重复处理 */
  private queueClear(unit: UnitDef, expect: unknown): void {
    const entry = { expect };
    const rowNo = this.last!.get(unit.code)?.rowNo;
    this.pendingClear.set(unit.code, entry);
    this.oneShot.push({
      write: { ...this.target(unit), range: KDOCS_LAYOUT.inputCell, values: [['']], expect },
      onSent: async () => {
        if (this.pendingClear.get(unit.code) === entry) this.pendingClear.delete(unit.code);
        const l = this.last!.get(unit.code);
        if (l && l.rowNo === rowNo) l.cleared = true;
        if (rowNo !== undefined) {
          await this.ctx.db.query('UPDATE kdocs_rows SET cleared = true WHERE event_id = $1 AND unit_code = $2 AND row_no = $3', [
            this.binding.event_id,
            unit.code,
            rowNo,
          ]);
        }
      },
    });
  }

  private async loadLast(): Promise<Map<string, ConsumedRow>> {
    const r = await this.ctx.db.query(
      `SELECT DISTINCT ON (unit_code) unit_code, row_no, status, target_raw, message, first_seen_at, cleared
         FROM kdocs_rows WHERE event_id = $1 ORDER BY unit_code, row_no DESC`,
      [this.binding.event_id],
    );
    const m = new Map<string, ConsumedRow>();
    for (const row of r.rows) {
      m.set(row.unit_code, { rowNo: row.row_no, cleared: row.cleared, status: row.status, targetRaw: row.target_raw ?? '', message: row.message, seenAt: row.first_seen_at });
    }
    return m;
  }

  private nextRowNo(unit: UnitDef): number {
    return (this.last!.get(unit.code)?.rowNo ?? 0) + 1;
  }

  private async consume(
    unit: UnitDef,
    rowNo: number,
    target: unknown,
    rec: { status: ConsumedRow['status']; message: string; projectCode?: string | null; fromPp?: number | null; toPp?: number | null; receiptNo?: string | null },
  ): Promise<void> {
    const r = await this.ctx.db.query(
      `INSERT INTO kdocs_rows (event_id, unit_code, row_no, target_raw, confirm_raw, status, project_code, from_pp, to_pp, receipt_no, message, cleared)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9, $10, false)
       ON CONFLICT (event_id, unit_code, row_no) DO NOTHING
       RETURNING first_seen_at`,
      [this.binding.event_id, unit.code, rowNo, rawText(target), rec.status, rec.projectCode ?? null, rec.fromPp ?? null, rec.toPp ?? null, rec.receiptNo ?? null, rec.message],
    );
    this.last!.set(unit.code, { rowNo, cleared: false, status: rec.status, targetRaw: rawText(target), message: rec.message, seenAt: r.rows[0]?.first_seen_at ?? new Date() });
    if (rec.status === 'APPLIED') this.stats.applied++;
    if (rec.status === 'REJECTED') this.stats.rejected++;
    if (rec.status !== 'PREEXISTING') this.stats.units.add(unit.code);
    this.dirty = true;
  }

  private async markBaseline(inputs: Map<string, unknown>): Promise<void> {
    for (const unit of UNITS) {
      const v = inputs.get(unit.name);
      if (isBlankCell(v)) continue;
      await this.consume(unit, this.nextRowNo(unit), v, { status: 'PREEXISTING', message: '开始读取前已填写，未处理' });
      this.queueClear(unit, v);
    }
    await this.ctx.db.query('UPDATE kdocs_bindings SET baseline_done = true WHERE event_id = $1', [this.binding.event_id]);
    this.binding.baseline_done = true;
    this.status.baselineDone = true;
  }

  private async loadMe(unitCode: string): Promise<MeSnapshot> {
    return withSnapshot(this.ctx.db, (tx) => bidderMe(tx, this.binding.event_id, unitCode));
  }

  /** 处理一家单位的「我要加到」：首次填写先认领底标，再按规则加码；处理后条件清空 */
  private async processUnit(unit: UnitDef, v: unknown): Promise<void> {
    if (isBlankCell(v)) return;
    const pend = this.pendingClear.get(unit.code);
    if (pend && rawText(pend.expect) === rawText(v)) return; // 已处理，清空指令尚未送达

    const eventId = this.binding.event_id;
    let rowNo = this.nextRowNo(unit);
    const parsed = parseTargetCell(v);
    if (!parsed.ok) {
      await this.consume(unit, rowNo, v, { status: 'REJECTED', message: parsed.reason });
      this.queueClear(unit, v);
      return;
    }

    const me = await this.loadMe(unit.code);
    const project = me.event.currentProject as ProjectCode;
    const p = me.projects[project] as MeProject;
    let acked = false;
    if (canAck(p)) {
      try {
        await acknowledgeBase(this.ctx, eventId, kdocsActor(unit), project, unit.code, { idempotencyKey: `kdack:${unit.code}:${project}:${eventId.slice(0, 8)}` }, { channel: 'KDOCS' });
        acked = true;
        this.stats.acked++;
      } catch (e) {
        if (!(e instanceof BizError)) throw e;
        await this.consume(unit, rowNo, v, { status: 'REJECTED', message: `无法确认底标：${e.message}`, projectCode: project });
        this.queueClear(unit, v);
        return;
      }
    }

    let outcome = await this.applyBid(unit, rowNo, parsed.pp);
    if (outcome.recovered && outcome.toPp !== parsed.pp) {
      // 程序上次加码成功后未来得及记录、领导又改了数字：先补记上一笔，再处理新数字
      await this.consume(unit, rowNo, outcome.toPp, outcome);
      rowNo++;
      outcome = await this.applyBid(unit, rowNo, parsed.pp);
    }
    if (acked) outcome = { ...outcome, message: `${outcome.message}，并确认底标` };
    await this.consume(unit, rowNo, v, outcome);
    this.queueClear(unit, v);
  }

  /** 与手机端同一套规则；幂等键包含序号，程序中断后重试不会重复加码 */
  private async applyBid(unit: UnitDef, rowNo: number, pp: number): Promise<Outcome & { recovered?: boolean }> {
    const eventId = this.binding.event_id;
    const keyPrefix = `kd:${unit.code}:${rowNo}:`;
    const done = await this.ctx.db.query(
      `SELECT project_code, from_pp, to_pp, receipt_no FROM bid_records WHERE event_id = $1 AND unit_code = $2 AND idempotency_key LIKE $3`,
      [eventId, unit.code, `${keyPrefix}%`],
    );
    if (done.rowCount) {
      const b = done.rows[0];
      return { status: 'APPLIED', message: appliedText(b.project_code, b.from_pp, b.to_pp), projectCode: b.project_code, fromPp: b.from_pp, toPp: b.to_pp, receiptNo: b.receipt_no, recovered: true };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const me = await this.loadMe(unit.code);
      const project = me.event.currentProject as ProjectCode;
      const p = me.projects[project] as MeProject;
      if (p.bidVersion === null) {
        return { status: 'REJECTED', message: '当前专场尚未开放', projectCode: project, toPp: pp };
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
        return { status: 'APPLIED', message: appliedText(project, b.fromPp, b.toPp), projectCode: project, fromPp: b.fromPp, toPp: b.toPp, receiptNo: b.receiptNo };
      } catch (e) {
        if (!(e instanceof BizError)) throw e;
        if (e.code === 'VERSION_CONFLICT') continue;
        return { status: 'REJECTED', message: e.message, projectCode: project, toPp: pp };
      }
    }
    return { status: 'REJECTED', message: '当前增幅刚被更新，请重新填写', toPp: pp };
  }

  // ------------------------------------------------------------ 写回内容

  private async computeDesired(): Promise<void> {
    const seqRow = await this.ctx.db.query<{ seq: string }>('SELECT seq FROM events WHERE id = $1', [this.binding.event_id]);
    const seq = Number(seqRow.rows[0]?.seq ?? 0);
    const now = Date.now();
    const stampDue = now - this.lastStampAt >= 30_000;
    if (seq === this.lastSeq && !this.dirty && !stampDue) return;

    const evRow = (await this.ctx.db.query('SELECT * FROM events WHERE id = $1', [this.binding.event_id])).rows[0];
    const cfg = readConfig(evRow);
    const steps = normalizeAllowedSteps(cfg.allowedIncrementSteps) ?? [5];
    const next = new Map<string, KdocsWrite>();
    const stamp = fmtTime(new Date());

    for (const unit of UNITS) {
      if (this.status.missingUnits.includes(unit.name)) continue;
      const me = await this.loadMe(unit.code);
      const project = me.event.currentProject as ProjectCode;
      const p = me.projects[project] as MeProject;
      const group = GROUP_BY_NO.get(unit.groupNo)!;
      const nt = nextTargets(p, steps, group.minIncreasePp);
      const baseNote = p.baseAcknowledged ? '（已确认）' : canAck(p) ? '（首次填写即确认）' : '';
      const info = [
        `${PROJECT_NAMES[project]} · ${statusText(p)}`,
        p.baseTargetWan ? `${p.baseTargetWan} 万元${baseNote}` : '—',
        p.currentPp !== null ? `${p.currentPp}%` : '—',
        nt.length ? nt.join(' / ') : optionsHint(p),
      ];
      const at = this.target(unit);
      put(next, at, KDOCS_LAYOUT.infoValueRange, info.map((v) => [v]));
      const l = this.last!.get(unit.code);
      put(next, at, KDOCS_LAYOUT.resultCell, [[l ? resultText(l) : '']]);
      // 读取时间：每 30 秒或有其他变化时更新
      put(next, at, KDOCS_LAYOUT.syncCell, [[stamp]]);
    }
    this.lastStampAt = now;
    this.desired = next;
    this.lastSeq = seq;
    this.dirty = false;
  }
}

function put(m: Map<string, KdocsWrite>, at: { file?: string; sheet: string }, range: string, values: unknown[][]): void {
  m.set(`${at.sheet}!${range}`, { ...at, range, values });
}

function appliedText(projectCode: string, fromPp: number, toPp: number): string {
  return `${PROJECT_NAMES[projectCode as ProjectCode] ?? ''}已生效：${fromPp}% → ${toPp}%`;
}

/** 「处理结果」一栏 */
export function resultText(c: ConsumedRow): string {
  const t = fmtTime(c.seenAt);
  if (c.status === 'APPLIED') return `✔ ${c.message}（${t}）`;
  if (c.status === 'PREEXISTING') return `— 「${c.targetRaw}」${c.message}，请重新填写`;
  return `✘ 「${c.targetRaw}」未生效：${c.message}（${t}），请重新填写`;
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
      JSON.stringify(existing.binding.unit_files) === JSON.stringify(b.unit_files)
    ) {
      existing.rebind(b);
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

  /** 现场状态变化后立即同步一轮（不等待结果，失败由下一轮重试） */
  wake(eventId: string): void {
    this.loops.get(eventId)?.syncNow().catch(() => {});
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
