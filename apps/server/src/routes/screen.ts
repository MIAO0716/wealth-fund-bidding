import { isProjectCode } from '@bidding/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { withSnapshot } from '../db/pool';
import { bizError } from '../lib/errors';
import { screenFirstRound, screenLive, screenResults } from '../services/views';
import { openStream } from './sse';

type P = { eventId: string; projectCode: string };

/** 大屏只读接口：只返回已发布（公开）数据 */
export function registerScreenRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, hub } = deps;
  const auth = { preHandler: deps.requireRole('SCREEN') };

  api.get('/screen/session', auth, async (req) => ({ eventId: req.session!.eventId }));

  api.get<{ Params: P; Querystring: { project?: string } }>('/screen/events/:eventId/live', auth, async (req) => {
    const p = req.query.project;
    if (p !== undefined && !isProjectCode(p)) throw bizError('NOT_FOUND', '项目不存在');
    return withSnapshot(ctx.db, (tx) => screenLive(tx, req.params.eventId, p));
  });

  api.get<{ Params: P }>('/screen/events/:eventId/projects/:projectCode/first-round', auth, async (req) => {
    if (!isProjectCode(req.params.projectCode)) throw bizError('NOT_FOUND', '项目不存在');
    return withSnapshot(ctx.db, (tx) => screenFirstRound(tx, req.params.eventId, req.params.projectCode as 'wealth' | 'fund'));
  });

  api.get<{ Params: P }>('/screen/events/:eventId/results', auth, async (req) =>
    withSnapshot(ctx.db, (tx) => screenResults(tx, req.params.eventId)),
  );

  api.get<{ Params: P }>('/screen/events/:eventId/stream', auth, async (req, reply) => {
    await openStream(hub, req, reply, { role: 'SCREEN', sessionId: req.session!.id, eventId: req.params.eventId, unitCode: null });
  });
}
