/**
 * 实时推送（SSE）：数据源为数据库 realtime_events（outbox）。
 * - 写事务内 pg_notify，提交后由 LISTEN 连接唤醒；另有定时兜底拉取，防止通知丢失。
 * - 每个连接维护自己的游标 lastSeq，按序从数据库读取并按权限过滤后推送，不会漏发、不会乱序。
 * - 断线重连时客户端带 Last-Event-ID / since，从该序列之后补发；序列超前（如备份恢复后）则要求重新同步全量快照。
 */

import type { RealtimeMessage } from '@bidding/shared';
import pg from 'pg';
import type { Db } from '../db/pool';
import type { Role } from './auth';

export const HEARTBEAT_MS = 15_000;
const SAFETY_POLL_MS = 3_000;

export interface Subscriber {
  id: number;
  role: Role;
  eventId: string;
  unitCode: string | null;
  lastSeq: number;
  connectedAt: Date;
  send: (event: string, data: unknown, id?: number) => void;
  close: () => void;
  busy: Promise<void>;
}

interface Row {
  seq: string;
  type: string;
  project_code: string | null;
  unit_code: string | null;
  audience: 'PUBLIC' | 'SCREEN' | 'UNIT' | 'ADMIN';
  data: Record<string, unknown>;
  created_at: Date;
}

export function visibleTo(role: Role, unitCode: string | null, row: Pick<Row, 'audience' | 'unit_code'>): boolean {
  if (role === 'ADMIN') return true;
  if (role === 'SCREEN') return row.audience === 'PUBLIC' || row.audience === 'SCREEN';
  // 领导：项目级公共消息 + 本单位相关消息
  if (row.audience === 'PUBLIC') return true;
  return (row.audience === 'SCREEN' || row.audience === 'UNIT') && row.unit_code === unitCode;
}

export class RealtimeHub {
  private subs = new Map<number, Subscriber>();
  private nextId = 1;
  private listener: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private db: Db, private databaseUrl: string, private log: (msg: string, err?: unknown) => void = () => {}) {}

  async start(): Promise<void> {
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.pumpAll(), SAFETY_POLL_MS));
    await this.connectListener();
  }

  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.payload) this.pumpEvent(msg.payload);
    });
    client.on('error', (err) => {
      this.log('实时监听连接异常，稍后重连', err);
      this.listener = null;
      client.end().catch(() => {});
      setTimeout(() => this.connectListener(), 2000);
    });
    try {
      await client.connect();
      await client.query('LISTEN bidding_realtime');
      this.listener = client;
    } catch (err) {
      this.log('实时监听连接失败，稍后重连', err);
      client.end().catch(() => {});
      setTimeout(() => this.connectListener(), 2000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    for (const s of this.subs.values()) s.close();
    this.subs.clear();
    await this.listener?.end().catch(() => {});
  }

  /** 注册连接；since 为客户端已拥有的最后序列（来自快照或 Last-Event-ID） */
  async subscribe(opts: Omit<Subscriber, 'id' | 'lastSeq' | 'connectedAt' | 'busy'> & { since: number }): Promise<Subscriber> {
    const sub: Subscriber = {
      ...opts,
      id: this.nextId++,
      lastSeq: opts.since,
      connectedAt: new Date(),
      busy: Promise.resolve(),
    };
    const head = await this.headSeq(opts.eventId);
    // 客户端序列超前于服务端（如恢复了旧备份）：要求重新获取全量快照
    if (opts.since > head) {
      sub.send('resync', { reason: 'AHEAD_OF_SERVER', headSeq: head });
      sub.lastSeq = head;
    }
    sub.send('hello', { headSeq: head, serverTime: new Date().toISOString(), heartbeatMs: HEARTBEAT_MS });
    this.subs.set(sub.id, sub);
    this.pump(sub);
    return sub;
  }

  unsubscribe(sub: Subscriber): void {
    this.subs.delete(sub.id);
  }

  stats() {
    const list = [...this.subs.values()].map((s) => ({
      id: s.id,
      role: s.role,
      eventId: s.eventId,
      unitCode: s.unitCode,
      lastSeq: s.lastSeq,
      connectedAt: s.connectedAt.toISOString(),
    }));
    return list;
  }

  private async headSeq(eventId: string): Promise<number> {
    const r = await this.db.query<{ seq: string }>('SELECT seq FROM events WHERE id = $1', [eventId]);
    return r.rowCount ? Number(r.rows[0].seq) : 0;
  }

  private heartbeat(): void {
    const now = new Date().toISOString();
    for (const s of this.subs.values()) s.send('heartbeat', { serverTime: now, lastSeq: s.lastSeq });
  }

  private pumpAll(): void {
    for (const s of this.subs.values()) this.pump(s);
  }

  private pumpEvent(eventId: string): void {
    for (const s of this.subs.values()) if (s.eventId === eventId) this.pump(s);
  }

  /** 每个连接串行拉取，保证顺序且不重复 */
  private pump(sub: Subscriber): void {
    sub.busy = sub.busy.then(async () => {
      if (!this.subs.has(sub.id)) return;
      try {
        for (;;) {
          const r = await this.db.query<Row>(
            `SELECT seq, type, project_code, unit_code, audience, data, created_at
               FROM realtime_events WHERE event_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`,
            [sub.eventId, sub.lastSeq],
          );
          for (const row of r.rows) {
            const seq = Number(row.seq);
            if (visibleTo(sub.role, sub.unitCode, row)) {
              const msg: RealtimeMessage = {
                seq,
                type: row.type as RealtimeMessage['type'],
                projectCode: row.project_code as RealtimeMessage['projectCode'],
                unitCode: row.unit_code,
                serverTime: row.created_at.toISOString(),
                data: row.data,
              };
              sub.send('message', msg, seq);
            }
            sub.lastSeq = seq;
          }
          if (r.rows.length < 200) break;
        }
      } catch (err) {
        this.log('推送拉取失败', err);
      }
    });
  }
}
