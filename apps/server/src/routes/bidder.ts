import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { withSnapshot } from '../db/pool';
import { bizError } from '../lib/errors';
import { actorOf } from '../services/auth';
import { lookupRequest, submitBid } from '../services/bids';
import { idemScope } from '../services/core';
import { acknowledgeBase } from '../services/projects';
import { bidderMe } from '../services/views';
import { openStream } from './sse';

type P = { eventId: string; projectCode: string; key: string };

export function registerBidderRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, hub } = deps;
  const auth = { preHandler: deps.requireRole('BIDDER') };

  api.get('/bidder/session', auth, async (req) => ({
    eventId: req.session!.eventId,
    unitCode: req.session!.unitCode,
    expiresAt: req.session!.expiresAt.toISOString(),
  }));

  api.get<{ Params: P }>('/bidder/events/:eventId/me', auth, async (req) =>
    withSnapshot(ctx.db, (tx) => bidderMe(tx, req.params.eventId, req.session!.unitCode!)),
  );

  api.post<{ Params: P }>('/bidder/events/:eventId/projects/:projectCode/base-ack', auth, async (req) => {
    const s = req.session!;
    const r = await acknowledgeBase(ctx, req.params.eventId, actorOf(s), req.params.projectCode, s.unitCode!, (req.body ?? {}) as object);
    return { ...r.body, replayed: r.replayed };
  });

  /** 提交追加：单位从会话读取，忽略请求体中的任何单位字段 */
  api.post<{ Params: P }>('/bidder/events/:eventId/projects/:projectCode/bids', auth, async (req, reply) => {
    const s = req.session!;
    const r = await submitBid(ctx, req.params.eventId, actorOf(s), req.params.projectCode, s.unitCode!, (req.body ?? {}) as object);
    return reply.status(r.statusCode).send({ receipt: r.body, replayed: r.replayed });
  });

  api.get<{ Params: P }>('/bidder/events/:eventId/requests/:key', auth, async (req) => {
    const s = req.session!;
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(req.params.key)) throw bizError('BAD_REQUEST', '请求标识不合法');
    return lookupRequest(ctx, idemScope(req.params.eventId, actorOf(s)), req.params.key);
  });

  api.get<{ Params: P }>('/bidder/events/:eventId/stream', auth, async (req, reply) => {
    await openStream(hub, req, reply, { role: 'BIDDER', eventId: req.params.eventId, unitCode: req.session!.unitCode });
  });
}
