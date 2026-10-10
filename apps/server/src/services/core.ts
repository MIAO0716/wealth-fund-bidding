/**
 * 写操作的公共基础：活动行锁、全局序列、持久实时事件（outbox）、审计日志、幂等。
 *
 * 约定：同一活动的所有写事务第一步都 `lockEvent()`（SELECT ... FOR UPDATE），
 * 因此加码、锁定、发布、组别开闭等在活动内严格串行，序列号按提交顺序递增且无空洞。
 */

import type { ProjectCode, RealtimeType } from '@bidding/shared';
import type { Tx } from '../db/pool';
import { bizError } from '../lib/errors';

export interface EventRow {
  id: string;
  is_demo: boolean;
  config: Record<string, unknown>;
  current_project: ProjectCode;
  screen_mode: string;
  screen_project: ProjectCode;
  seq: string;
  draft_version: number;
  archived: boolean;
}

export type Audience = 'PUBLIC' | 'SCREEN' | 'UNIT' | 'ADMIN';

export interface Actor {
  type: 'ADMIN' | 'LEADER' | 'SYSTEM';
  id: string;
  name: string;
  /** 领导会话绑定的单位 */
  unitCode?: string;
}

export async function lockEvent(tx: Tx, eventId: string): Promise<EventRow> {
  const r = await tx.query<EventRow>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
  if (!r.rowCount) throw bizError('NOT_FOUND', '活动不存在');
  return r.rows[0];
}

/** 在当前事务内追加一条实时事件并返回其序列号；事务提交后才对外可见 */
export async function emit(
  tx: Tx,
  eventId: string,
  e: {
    type: RealtimeType;
    audience: Audience;
    projectCode?: ProjectCode | null;
    unitCode?: string | null;
    data?: Record<string, unknown>;
  },
): Promise<number> {
  const r = await tx.query<{ seq: string }>('UPDATE events SET seq = seq + 1 WHERE id = $1 RETURNING seq', [eventId]);
  const seq = Number(r.rows[0].seq);
  await tx.query(
    `INSERT INTO realtime_events (event_id, seq, type, project_code, unit_code, audience, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [eventId, seq, e.type, e.projectCode ?? null, e.unitCode ?? null, e.audience, JSON.stringify(e.data ?? {})],
  );
  // NOTIFY 在提交时才投递，保证只推送已提交数据
  await tx.query(`SELECT pg_notify('bidding_realtime', $1)`, [eventId]);
  return seq;
}

export async function audit(
  tx: Tx,
  eventId: string | null,
  actor: Actor,
  action: string,
  opts: {
    projectCode?: ProjectCode | null;
    unitCode?: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
    eventSequence?: number | null;
  } = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (event_id, project_code, unit_code, action, actor_type, actor_id, actor_name, reason, details, event_sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      eventId,
      opts.projectCode ?? null,
      opts.unitCode ?? null,
      action,
      actor.type,
      actor.id,
      actor.name,
      opts.reason ?? null,
      JSON.stringify(opts.details ?? {}),
      opts.eventSequence ?? null,
    ],
  );
}

export function idemScope(eventId: string, actor: Actor): string {
  if (actor.type === 'LEADER') return `unit:${eventId}:${actor.unitCode}`;
  return `${actor.type.toLowerCase()}:${eventId}:${actor.id}`;
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
  operation: string;
}

/**
 * 先查幂等历史：相同键 + 相同内容 → 返回原结果；相同键 + 不同内容 → 冲突。
 * 必须在活动行锁之后调用，避免并发重复处理。
 */
export async function checkIdempotency(
  tx: Tx,
  scope: string,
  key: string,
  requestHash: string,
): Promise<StoredResponse | null> {
  const r = await tx.query<{ request_hash: string; status_code: number; response: unknown; operation: string }>(
    'SELECT request_hash, status_code, response, operation FROM idempotency_records WHERE scope = $1 AND idem_key = $2',
    [scope, key],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  if (row.request_hash !== requestHash) throw bizError('IDEMPOTENCY_CONFLICT');
  return { statusCode: row.status_code, body: row.response, operation: row.operation };
}

export async function saveIdempotency(
  tx: Tx,
  scope: string,
  key: string,
  operation: string,
  requestHash: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO idempotency_records (scope, idem_key, operation, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [scope, key, operation, requestHash, statusCode, JSON.stringify(body)],
  );
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
    throw bizError('BAD_REQUEST', 'idempotencyKey 须为 8–128 位字母、数字或 -_:. 组成的唯一标识');
  }
  return key;
}
