import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app';
import { bizError } from '../lib/errors';
import { actorOf } from '../services/auth';
import { getEventRow } from '../services/events';
import { connectKdocs, getKdocsOverview, initKdocsLayout, kdocsCards, saveKdocsBinding, testKdocs, useKdocsMock } from '../services/kdocs/admin';
import { AIRSCRIPT_SOURCE } from '../services/kdocs/airscript';
import { buildKdocsTemplate, buildKdocsTemplateZip } from '../services/kdocs/template';

type P = { eventId: string };
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

function attachment(fallback: string, name: string): string {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 管理端：金山文档接入（/api/v1/admin/...） */
export function registerKdocsAdminRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, kdocs } = deps;
  const requireAdmin = deps.requireRole('ADMIN');
  const ensureEvent = async (req: FastifyRequest) => {
    const id = (req.params as { eventId?: string }).eventId;
    if (id) await getEventRow(ctx.db, id);
  };
  const auth = { preHandler: [requireAdmin, ensureEvent] };
  const actor = (req: FastifyRequest) => actorOf(req.session!);

  api.get<{ Params: P }>('/admin/events/:eventId/kdocs', auth, async (req) => getKdocsOverview(kdocs, req.params.eventId));

  api.get<{ Params: P }>('/admin/events/:eventId/kdocs/cards', auth, async (req) => kdocsCards(kdocs, req.params.eventId));

  api.put<{ Params: P }>('/admin/events/:eventId/kdocs', auth, async (req) => saveKdocsBinding(kdocs, req.params.eventId, actor(req), body(req)));

  api.post<{ Params: P }>('/admin/events/:eventId/kdocs/connect', auth, async (req) => connectKdocs(kdocs, req.params.eventId, actor(req), body(req)));

  api.post<{ Params: P }>('/admin/events/:eventId/kdocs/test', auth, async (req) => testKdocs(kdocs, req.params.eventId));

  api.post<{ Params: P }>('/admin/events/:eventId/kdocs/init-layout', auth, async (req) => initKdocsLayout(kdocs, req.params.eventId, actor(req), body(req)));

  api.post<{ Params: P }>('/admin/events/:eventId/kdocs/sync-now', auth, async (req) => {
    if (!kdocs.sync.isActive(req.params.eventId)) throw bizError('INVALID_STATE', '同步尚未开启');
    try {
      await kdocs.sync.syncNow(req.params.eventId);
    } catch (e) {
      throw bizError('BAD_REQUEST', (e as Error).message);
    }
    return getKdocsOverview(kdocs, req.params.eventId);
  });

  api.post<{ Params: P }>('/admin/events/:eventId/kdocs/use-mock', auth, async (req) => {
    const addr = req.server.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : ctx.config.port;
    return useKdocsMock(kdocs, req.params.eventId, actor(req), port, body(req).mode);
  });

  api.get<{ Params: P }>('/admin/events/:eventId/kdocs/template.xlsx', auth, async (req, reply) => {
    const ev = await getEventRow(ctx.db, req.params.eventId);
    const buf = await buildKdocsTemplate({ title: String((ev.config as { name?: string }).name || '理财、基金现场竞标') });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', attachment('kdocs-template.xlsx', '金山文档填报表模板.xlsx'))
      .send(buf);
  });

  api.get<{ Params: P }>('/admin/events/:eventId/kdocs/template-files.zip', auth, async (req, reply) => {
    const ev = await getEventRow(ctx.db, req.params.eventId);
    const buf = await buildKdocsTemplateZip({ title: String((ev.config as { name?: string }).name || '理财、基金现场竞标') });
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', attachment('kdocs-unit-files.zip', '金山文档填报表-每家单位一个文件.zip'))
      .send(buf);
  });

  api.get('/admin/kdocs/airscript.js', { preHandler: [requireAdmin] }, async (_req, reply) =>
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', attachment('bidding-sync-airscript.js', '竞标同步脚本-AirScript.js'))
      .send(AIRSCRIPT_SOURCE),
  );
}

/**
 * 模拟金山文档
 * - POST /mock-kdocs/api/v3/ide/file/:fileId/script/:scriptId/sync_task  与金山文档相同的脚本接口
 * - GET  /api/v1/mock-kdocs/files/:fileId                                模拟表格网页读取
 * - PUT  /api/v1/mock-kdocs/files/:fileId/cell                           模拟领导填写
 */
export function registerKdocsMockRoutes(app: FastifyInstance, deps: AppDeps): void {
  const mock = deps.kdocs.mock;
  if (!mock) return;
  app.post<{ Params: { fileId: string; scriptId: string } }>('/mock-kdocs/api/v3/ide/file/:fileId/script/:scriptId/sync_task', async (req, reply) => {
    const token = req.headers['airscript-token'];
    const r = await mock.syncTask(req.params.fileId, typeof token === 'string' ? token : undefined, req.body);
    return reply.status(r.httpStatus).send(r.body);
  });
}

export function registerKdocsMockApi(api: FastifyInstance, deps: AppDeps): void {
  const mock = deps.kdocs.mock;
  if (!mock) return;
  api.get<{ Params: { fileId: string } }>('/mock-kdocs/files/:fileId', async (req) => {
    const snap = mock.snapshot(req.params.fileId);
    if (!snap) throw bizError('NOT_FOUND', '模拟文件不存在：请在管理端「金山文档」中点「使用模拟金山文档」');
    return snap;
  });
  api.put<{ Params: { fileId: string } }>('/mock-kdocs/files/:fileId/cell', async (req) => {
    const b = body(req);
    try {
      mock.editCell(req.params.fileId, String(b.sheet ?? ''), String(b.cell ?? ''), b.value ?? null);
    } catch (e) {
      throw bizError('BAD_REQUEST', (e as Error).message);
    }
    return { ok: true };
  });
}
