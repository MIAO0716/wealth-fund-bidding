/**
 * 现场加码事务：领导端与管理员代录共用同一套校验。
 * 请求发送「最终确认增幅」，服务端校验为整数且高于当前值（每次至少 1 个百分点）；单位取自认证会话，不信任请求体。
 */

import {
  type BidReceipt,
  GROUP_BY_NO,
  type ProjectCode,
  UNIT_BY_CODE,
  checkBidTarget,
  fenToWanExact,
  targetFen,
} from '@bidding/shared';
import { uuid } from '../lib/crypto';
import { bizError } from '../lib/errors';
import { type Actor, audit, emit } from './core';
import { type AppContext, runWrite } from './context';
import { readConfig } from './events';
import { lockProject, parseProject } from './projects';

export interface BidInput {
  targetIncreasePp?: unknown;
  expectedBidVersion?: unknown;
  idempotencyKey?: unknown;
  confirmHighValue?: unknown;
  reason?: unknown;
}

export function receiptNo(projectCode: ProjectCode, unitCode: string, version: number, seq: number): string {
  return `${projectCode === 'wealth' ? 'LC' : 'JJ'}-${unitCode}-${String(version).padStart(3, '0')}-${seq}`;
}

export async function submitBid(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  projectCodeRaw: unknown,
  unitCode: string,
  input: BidInput,
  /** 内部调用渠道（不来自请求体）：金山文档同步 */
  opts: { channel?: 'KDOCS' } = {},
) {
  const projectCode = parseProject(projectCodeRaw);
  const unit = UNIT_BY_CODE.get(unitCode);
  if (!unit) throw bizError('NOT_FOUND', '单位不存在');
  const proxy = actor.type === 'ADMIN';
  const source = opts.channel ?? (proxy ? 'ADMIN_PROXY' : 'LEADER');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (typeof input.expectedBidVersion !== 'number' || !Number.isInteger(input.expectedBidVersion)) {
    throw bizError('BAD_REQUEST', 'expectedBidVersion 须为整数');
  }

  return runWrite<BidReceipt>(
    ctx,
    eventId,
    actor,
    {
      operation: proxy ? 'BID_PROXY' : 'BID',
      idempotencyKey: input.idempotencyKey,
      request: {
        projectCode,
        unitCode,
        targetIncreasePp: input.targetIncreasePp,
        expectedBidVersion: input.expectedBidVersion,
        confirmHighValue: input.confirmHighValue === true,
        reason,
      },
      storeFailures: true,
      failureLog: { projectCode, unitCode },
    },
    async (tx, ev) => {
      const config = readConfig(ev);
      // 1. 项目为当前专场
      const project = await lockProject(tx, eventId, projectCode);
      if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED');
      if (ev.current_project !== projectCode) throw bizError('PROJECT_NOT_ACTIVE');
      // 2. 项目 LIVE、本组 OPEN、底标已确认
      if (project.status === 'PAUSED') throw bizError('PROJECT_PAUSED');
      if (project.status !== 'LIVE') throw bizError('PROJECT_NOT_ACTIVE');
      const g = await tx.query<{ status: string }>(
        'SELECT status FROM project_groups WHERE event_id = $1 AND project_code = $2 AND group_no = $3',
        [eventId, projectCode, unit.groupNo],
      );
      if (g.rows[0]?.status !== 'OPEN') throw bizError('GROUP_NOT_OPEN');
      const s = await tx.query(
        'SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2 AND unit_code = $3 FOR UPDATE',
        [eventId, projectCode, unitCode],
      );
      const state = s.rows[0];
      if (!state.base_ack_at) throw bizError('BASE_NOT_ACKNOWLEDGED');
      // 3. 乐观版本
      if (input.expectedBidVersion !== state.version) {
        throw bizError('VERSION_CONFLICT', undefined, { currentPp: state.current_pp, bidVersion: state.version });
      }
      // 4–5. 整数百分点、大于当前值（每次至少 1 个百分点）、满足组别底线
      const check = checkBidTarget({
        currentPp: state.current_pp,
        targetPp: input.targetIncreasePp,
        groupMinPp: GROUP_BY_NO.get(unit.groupNo)!.minIncreasePp,
      });
      if (!check.ok) {
        throw bizError(check.code === 'NOT_GREATER' ? 'NOT_GREATER' : check.code === 'INVALID_STEP' ? 'INVALID_STEP' : 'INVALID_VALUE', check.reason, {
          currentPp: state.current_pp,
        });
      }
      const toPp = input.targetIncreasePp as number;
      if (toPp >= config.highValueConfirmPp && input.confirmHighValue !== true) {
        throw bizError('HIGH_VALUE_CONFIRM_REQUIRED', `新增幅 ${toPp}% 较大，请再次明确确认`, { targetIncreasePp: toPp });
      }
      // 6. 原子写入：当前记录、版本、流水、同步事件
      const baseFen = BigInt(state.base_target_fen);
      const tFen = targetFen(baseFen, toPp);
      const newVersion = state.version + 1;
      await tx.query(
        `UPDATE bid_states SET current_pp = $4, version = $5, updated_at = now()
          WHERE event_id = $1 AND project_code = $2 AND unit_code = $3`,
        [eventId, projectCode, unitCode, toPp, newVersion],
      );
      const bidId = uuid();
      const acceptedAt = new Date();
      const seq = await emit(tx, eventId, {
        type: 'BID_ACCEPTED',
        audience: 'SCREEN',
        projectCode,
        unitCode,
        data: {
          bidId,
          fromPp: state.current_pp,
          toPp,
          bidVersion: newVersion,
          source,
          acceptedAt: acceptedAt.toISOString(),
        },
      });
      const receipt: BidReceipt = {
        bidId,
        receiptNo: receiptNo(projectCode, unitCode, newVersion, seq),
        unitCode,
        projectCode,
        fromPp: state.current_pp,
        toPp,
        deltaPp: check.deltaPp,
        baseTargetWan: fenToWanExact(baseFen),
        targetWan: fenToWanExact(tFen),
        targetFen: tFen.toString(),
        bidVersion: newVersion,
        eventSequence: seq,
        acceptedAt: acceptedAt.toISOString(),
        source,
      };
      await tx.query(
        `INSERT INTO bid_records (id, receipt_no, event_id, project_code, unit_code, from_pp, to_pp, delta_pp, base_target_fen, target_fen,
                                  source, actor_type, actor_id, reason, bid_version, event_sequence, idempotency_key, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          bidId,
          receipt.receiptNo,
          eventId,
          projectCode,
          unitCode,
          state.current_pp,
          toPp,
          check.deltaPp,
          baseFen.toString(),
          tFen.toString(),
          receipt.source,
          actor.type,
          actor.id,
          reason || null,
          newVersion,
          seq,
          String(input.idempotencyKey),
          acceptedAt,
        ],
      );
      await audit(tx, eventId, actor, proxy ? 'BID_PROXY' : 'BID', {
        projectCode,
        unitCode,
        reason: reason || null,
        details: { receiptNo: receipt.receiptNo, fromPp: state.current_pp, toPp, channel: source },
        eventSequence: seq,
      });
      return { statusCode: 201, body: receipt };
    },
  );
}

export interface CorrectInput {
  targetIncreasePp?: unknown;
  expectedBidVersion?: unknown;
  idempotencyKey?: unknown;
  reason?: unknown;
}

/**
 * 管理端更正（下调）：现场领导误操作时，工作人员在锁定前把增幅改回正确值。
 * 只允许管理员；目标须为整数、低于当前增幅、不低于首轮增幅（首轮快照不可动）。
 * 竞标开始后到锁定前均可使用（含本组已结束、暂停核对时）；单独记流水与审计，大屏与手机即时更新。
 */
export async function correctBid(ctx: AppContext, eventId: string, actor: Actor, projectCodeRaw: unknown, unitCode: string, input: CorrectInput) {
  const projectCode = parseProject(projectCodeRaw);
  const unit = UNIT_BY_CODE.get(unitCode);
  if (!unit) throw bizError('NOT_FOUND', '单位不存在');
  if (actor.type !== 'ADMIN') throw bizError('FORBIDDEN', '只有工作人员可以更正增幅');
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : '工作人员更正（领导误操作）';
  if (typeof input.expectedBidVersion !== 'number' || !Number.isInteger(input.expectedBidVersion)) {
    throw bizError('BAD_REQUEST', 'expectedBidVersion 须为整数');
  }
  return runWrite<BidReceipt>(
    ctx,
    eventId,
    actor,
    {
      operation: 'BID_CORRECT',
      idempotencyKey: input.idempotencyKey,
      request: { projectCode, unitCode, targetIncreasePp: input.targetIncreasePp, expectedBidVersion: input.expectedBidVersion },
      storeFailures: true,
      failureLog: { projectCode, unitCode },
    },
    async (tx) => {
      const project = await lockProject(tx, eventId, projectCode);
      if (project.status === 'LOCKED') throw bizError('PROJECT_LOCKED', '项目已锁定，结果不可更正');
      if (project.status !== 'LIVE' && project.status !== 'PAUSED') throw bizError('PROJECT_NOT_ACTIVE', '竞标开始后才能更正增幅');
      const s = await tx.query(
        'SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2 AND unit_code = $3 FOR UPDATE',
        [eventId, projectCode, unitCode],
      );
      const state = s.rows[0];
      if (input.expectedBidVersion !== state.version) {
        throw bizError('VERSION_CONFLICT', undefined, { currentPp: state.current_pp, bidVersion: state.version });
      }
      const toPp = input.targetIncreasePp;
      if (typeof toPp !== 'number' || !Number.isInteger(toPp)) throw bizError('INVALID_VALUE', '目标增幅须为整数百分点');
      if (toPp >= state.current_pp || toPp < state.first_round_pp) {
        throw bizError('NOT_LOWER', `更正后的增幅须低于当前 ${state.current_pp}%，且不低于首轮 ${state.first_round_pp}%`, {
          currentPp: state.current_pp,
          firstRoundPp: state.first_round_pp,
        });
      }
      const baseFen = BigInt(state.base_target_fen);
      const tFen = targetFen(baseFen, toPp);
      const newVersion = state.version + 1;
      // 只在本事务内放开数据库「只增不减」兜底
      await tx.query(`SELECT set_config('bidding.correction', 'on', true)`);
      await tx.query(
        `UPDATE bid_states SET current_pp = $4, version = $5, updated_at = now()
          WHERE event_id = $1 AND project_code = $2 AND unit_code = $3`,
        [eventId, projectCode, unitCode, toPp, newVersion],
      );
      await tx.query(`SELECT set_config('bidding.correction', 'off', true)`);
      const bidId = uuid();
      const acceptedAt = new Date();
      const source = 'ADMIN_CORRECTION' as const;
      const seq = await emit(tx, eventId, {
        type: 'BID_CORRECTED',
        audience: 'SCREEN',
        projectCode,
        unitCode,
        data: { bidId, fromPp: state.current_pp, toPp, bidVersion: newVersion, source, acceptedAt: acceptedAt.toISOString() },
      });
      const receipt: BidReceipt = {
        bidId,
        receiptNo: receiptNo(projectCode, unitCode, newVersion, seq),
        unitCode,
        projectCode,
        fromPp: state.current_pp,
        toPp,
        deltaPp: toPp - state.current_pp,
        baseTargetWan: fenToWanExact(baseFen),
        targetWan: fenToWanExact(tFen),
        targetFen: tFen.toString(),
        bidVersion: newVersion,
        eventSequence: seq,
        acceptedAt: acceptedAt.toISOString(),
        source,
      };
      await tx.query(
        `INSERT INTO bid_records (id, receipt_no, event_id, project_code, unit_code, from_pp, to_pp, delta_pp, base_target_fen, target_fen,
                                  source, actor_type, actor_id, reason, bid_version, event_sequence, idempotency_key, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          bidId,
          receipt.receiptNo,
          eventId,
          projectCode,
          unitCode,
          state.current_pp,
          toPp,
          receipt.deltaPp,
          baseFen.toString(),
          tFen.toString(),
          source,
          actor.type,
          actor.id,
          reason,
          newVersion,
          seq,
          String(input.idempotencyKey),
          acceptedAt,
        ],
      );
      await audit(tx, eventId, actor, 'BID_CORRECTED', {
        projectCode,
        unitCode,
        reason,
        details: { receiptNo: receipt.receiptNo, fromPp: state.current_pp, toPp },
        eventSequence: seq,
      });
      return { statusCode: 201, body: receipt };
    },
  );
}

/** 查询本单位（或管理员）某个幂等键的处理结果，用于网络超时后的回执核验 */
export async function lookupRequest(ctx: AppContext, scope: string, key: string) {
  const r = await ctx.db.query(
    'SELECT operation, status_code, response, created_at FROM idempotency_records WHERE scope = $1 AND idem_key = $2',
    [scope, key],
  );
  if (!r.rowCount) return { found: false as const, status: 'NOT_FOUND' as const };
  const row = r.rows[0];
  return {
    found: true as const,
    status: row.status_code < 400 ? ('SUCCEEDED' as const) : ('FAILED' as const),
    operation: row.operation,
    statusCode: row.status_code,
    response: row.response,
    recordedAt: row.created_at.toISOString(),
  };
}
