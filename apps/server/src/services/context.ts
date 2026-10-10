import type { AppConfig } from '../config';
import type { Db, Queryable, Tx } from '../db/pool';
import { BizError, bizError } from '../lib/errors';
import { digest } from '../lib/crypto';
import {
  type Actor,
  type EventRow,
  checkIdempotency,
  idemScope,
  lockEvent,
  saveIdempotency,
  validateIdempotencyKey,
} from './core';

export interface AppContext {
  db: Db;
  config: AppConfig;
  /** 首轮发布、项目锁定后的检查点钩子（备份） */
  onCheckpoint?: (eventId: string, label: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

export interface WriteResult<T> {
  statusCode: number;
  body: T;
  /** 是否为幂等重放的原结果 */
  replayed: boolean;
}

export interface WriteOptions {
  operation: string;
  /** 不传则该操作不做幂等处理 */
  idempotencyKey?: unknown;
  /** 参与摘要的请求内容（不含幂等键） */
  request?: unknown;
  /** 业务失败是否也记入幂等记录（加码、底标确认为 true） */
  storeFailures?: boolean;
  /** 记录失败提交（用于监控） */
  failureLog?: { projectCode?: string | null; unitCode?: string | null };
}

/**
 * 活动内写操作统一入口：事务 + 活动行锁 + 只读检查 + 幂等历史优先。
 */
export async function runWrite<T>(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  opts: WriteOptions,
  fn: (tx: Tx, event: EventRow) => Promise<{ statusCode?: number; body: T }>,
): Promise<WriteResult<T>> {
  if (ctx.config.readOnly) throw bizError('READ_ONLY');
  const key = opts.idempotencyKey === undefined ? null : validateIdempotencyKey(opts.idempotencyKey);
  const scope = idemScope(eventId, actor);
  const requestHash = digest({ op: opts.operation, req: opts.request ?? null });
  const client = await ctx.db.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const event = await lockEvent(client, eventId);
    if (key) {
      const stored = await checkIdempotency(client, scope, key, requestHash);
      if (stored) {
        await client.query('COMMIT');
        if (stored.statusCode >= 400) {
          const errBody = stored.body as { error: { code: never; message: string; details?: unknown } };
          throw new BizError(errBody.error.code, errBody.error.message, errBody.error.details);
        }
        return { statusCode: stored.statusCode, body: stored.body as T, replayed: true };
      }
    }
    const out = await fn(client, event);
    const statusCode = out.statusCode ?? 200;
    if (key) await saveIdempotency(client, scope, key, opts.operation, requestHash, statusCode, out.body);
    await client.query('COMMIT');
    return { statusCode, body: out.body, replayed: false };
  } catch (err) {
    // 回滚后继续用同一连接记录失败，不在持有连接时再向连接池申请新连接（并发失败时会互等、占满连接池）
    let healthy = true;
    await client.query('ROLLBACK').catch(() => {
      healthy = false;
    });
    if (!healthy) {
      // 连接已损坏：先丢弃再用连接池记录
      released = true;
      client.release(true);
    }
    if (err instanceof BizError && err.code !== 'IDEMPOTENCY_CONFLICT' && err.code !== 'READ_ONLY') {
      await recordFailure(healthy ? client : ctx.db, eventId, actor, opts, key, scope, requestHash, err).catch((e) =>
        ctx.log?.(`记录失败提交出错（${opts.operation} ${err.code}）`, e),
      );
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

async function recordFailure(
  q: Queryable,
  eventId: string,
  actor: Actor,
  opts: WriteOptions,
  key: string | null,
  scope: string,
  requestHash: string,
  err: BizError,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (key && opts.storeFailures && err.code !== 'NOT_FOUND') {
    tasks.push(
      q.query(
        `INSERT INTO idempotency_records (scope, idem_key, operation, request_hash, status_code, response)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [scope, key, opts.operation, requestHash, err.status, JSON.stringify(err.toBody())],
      ),
    );
  }
  if (opts.failureLog) {
    tasks.push(
      q.query(
        `INSERT INTO failed_submissions (event_id, project_code, unit_code, actor_type, actor_id, operation, error_code, message)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE EXISTS (SELECT 1 FROM events WHERE id = $1)`,
        [
          eventId,
          opts.failureLog.projectCode ?? null,
          opts.failureLog.unitCode ?? null,
          actor.type,
          actor.id,
          opts.operation,
          err.code,
          err.message,
        ],
      ),
    );
  }
  await Promise.all(tasks);
}

