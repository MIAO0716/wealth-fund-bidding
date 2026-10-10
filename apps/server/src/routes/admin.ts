import { PROJECT_CODES, UNITS } from '@bidding/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app';
import { withSnapshot } from '../db/pool';
import { bizError } from '../lib/errors';
import { toIso } from '../lib/time';
import {
  actorOf,
  createScreenKey,
  issueUnitCredential,
  listScreenKeys,
  revokeScreenKey,
  revokeUnitSessions,
  unitAccessStatus,
} from '../services/auth';
import { lookupRequest, submitBid } from '../services/bids';
import { idemScope } from '../services/core';
import { createDemoEvent, seedDemo } from '../services/demo';
import {
  archiveEvent,
  configProblems,
  createEvent,
  getEventRow,
  listEvents,
  readConfig,
  setScreenMode,
  toSummary,
  updateConfig,
} from '../services/events';
import { collectExport, toCsv, toXlsx } from '../services/exports';
import { parseUpload } from '../services/fileparse';
import { commitImport, listBatches, manualEdit, validateImport } from '../services/imports';
import {
  acknowledgeBase,
  controlProject,
  firstRoundProblems,
  lockPreview,
  parseProject,
  parseUnit,
  publishFirstRound,
} from '../services/projects';
import { templateCsv, templateXlsx } from '../services/templates';
import { adminFirstRound, adminState } from '../services/views';
import { openStream } from './sse';

type P = { eventId: string; projectCode: string; unitCode: string; key: string; keyId: string };

/** 附件文件名：ASCII 兜底 + RFC 5987 中文文件名 */
function attachment(fallback: string, name: string): string {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export function registerAdminRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, hub } = deps;
  const requireAdmin = deps.requireRole('ADMIN');
  const ensureEvent = async (req: FastifyRequest) => {
    const id = (req.params as { eventId?: string }).eventId;
    if (id) await getEventRow(ctx.db, id);
  };
  const auth = { preHandler: [requireAdmin, ensureEvent] };
  const actor = (req: FastifyRequest) => actorOf(req.session!);
  const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;

  // ------------------------------------------------------------ 活动

  api.get('/admin/events', auth, async () => ({ events: await listEvents(ctx.db) }));

  api.post('/admin/events', auth, async (req, reply) => {
    const b = body<{ isDemo?: boolean; config?: unknown; parentEventId?: string; parentReason?: string }>(req);
    const id = b.isDemo
      ? await createDemoEvent(ctx, actor(req))
      : await createEvent(ctx, actor(req), { isDemo: false, config: b.config, parentEventId: b.parentEventId, parentReason: b.parentReason });
    return reply.status(201).send({ event: toSummary(await getEventRow(ctx.db, id)) });
  });

  api.get<{ Params: P }>('/admin/events/:eventId', auth, async (req) => ({ event: toSummary(await getEventRow(ctx.db, req.params.eventId)) }));

  api.patch<{ Params: P }>('/admin/events/:eventId/config', auth, async (req) => {
    const r = await updateConfig(ctx, req.params.eventId, actor(req), req.body);
    return r.body;
  });

  api.post<{ Params: P }>('/admin/events/:eventId/archive', auth, async (req) => (await archiveEvent(ctx, req.params.eventId, actor(req))).body);

  /** 正式开启前检查：配置、首轮完整性、二维码发放 */
  api.get<{ Params: P }>('/admin/events/:eventId/readiness', auth, async (req) =>
    withSnapshot(ctx.db, async (tx) => {
      const ev = await getEventRow(tx, req.params.eventId);
      const config = configProblems(readConfig(ev));
      const projects: Record<string, unknown> = {};
      for (const p of PROJECT_CODES) {
        const status = (await tx.query('SELECT status FROM projects WHERE event_id = $1 AND project_code = $2', [ev.id, p])).rows[0].status;
        projects[p] = { status, problems: status === 'DRAFT' ? await firstRoundProblems(tx, ev.id, p) : [] };
      }
      const access = await unitAccessStatus(tx, ev.id);
      return {
        isDemo: ev.is_demo,
        configProblems: config,
        projects,
        unitsWithoutCredential: access.filter((a) => a.credentialStatus === 'NONE').map((a) => a.unitCode),
      };
    }),
  );

  api.get<{ Params: P }>('/admin/events/:eventId/state', auth, async (req) => withSnapshot(ctx.db, (tx) => adminState(tx, req.params.eventId)));

  api.post<{ Params: P }>('/admin/events/:eventId/screen-mode', auth, async (req) => (await setScreenMode(ctx, req.params.eventId, actor(req), body(req))).body);

  api.post<{ Params: P }>('/admin/events/:eventId/demo/seed', auth, async (req) => (await seedDemo(ctx, req.params.eventId, actor(req))).body);

  // ------------------------------------------------------------ 首轮数据

  api.get('/admin/first-round/template.xlsx', auth, async (_req, reply) =>
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', attachment('first-round-template.xlsx', '首轮数据模板.xlsx'))
      .send(await templateXlsx()),
  );

  api.get('/admin/first-round/template.csv', auth, async (_req, reply) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', attachment('first-round-template.csv', '首轮数据模板.csv'))
      .send(templateCsv()),
  );

  api.get<{ Params: P }>('/admin/events/:eventId/first-round', auth, async (req) =>
    withSnapshot(ctx.db, async (tx) => ({ ...(await adminFirstRound(tx, req.params.eventId)), batches: await listBatches(tx, req.params.eventId) })),
  );

  api.post<{ Params: P }>('/admin/events/:eventId/first-round/imports/validate', auth, async (req) => {
    const b = body<{ mode?: unknown; rows?: unknown }>(req);
    return validateImport(ctx, req.params.eventId, actor(req), { mode: b.mode, rows: b.rows, source: 'JSON' });
  });

  api.post<{ Params: P }>('/admin/events/:eventId/first-round/imports/upload', auth, async (req) => {
    const file = await req.file();
    if (!file) throw bizError('BAD_REQUEST', '请选择要上传的文件');
    const buf = await file.toBuffer();
    const parsed = await parseUpload(file.filename, buf);
    if (parsed.rows.length === 0) throw bizError('BAD_REQUEST', '文件中没有填写任何数据行（底标与增幅均为空的行已跳过）');
    return validateImport(ctx, req.params.eventId, actor(req), {
      rows: parsed.rows,
      source: parsed.source,
      fileName: file.filename,
      skippedBlank: parsed.skippedBlank,
    });
  });

  api.post<{ Params: P }>('/admin/events/:eventId/first-round/imports/commit', auth, async (req) => {
    const r = await commitImport(ctx, req.params.eventId, actor(req), body(req));
    return { ...r.body, replayed: r.replayed };
  });

  api.put<{ Params: P }>('/admin/events/:eventId/first-round/drafts/:projectCode/:unitCode', auth, async (req) => {
    const r = await manualEdit(ctx, req.params.eventId, actor(req), parseProject(req.params.projectCode), parseUnit(req.params.unitCode), body(req));
    return { ...r.body, replayed: r.replayed };
  });

  api.post<{ Params: P }>('/admin/events/:eventId/projects/:projectCode/publish-first-round', auth, async (req) => {
    const r = await publishFirstRound(ctx, req.params.eventId, actor(req), req.params.projectCode, body(req));
    return { ...r.body, replayed: r.replayed };
  });

  // ------------------------------------------------------------ 现场控制

  api.post<{ Params: P }>('/admin/events/:eventId/projects/:projectCode/control', auth, async (req) => {
    const r = await controlProject(ctx, req.params.eventId, actor(req), req.params.projectCode, body(req));
    return { ...r.body, replayed: r.replayed };
  });

  api.get<{ Params: P }>('/admin/events/:eventId/projects/:projectCode/lock-preview', auth, async (req) =>
    withSnapshot(ctx.db, (tx) => lockPreview(tx, req.params.eventId, parseProject(req.params.projectCode))),
  );

  api.post<{ Params: P }>('/admin/events/:eventId/projects/:projectCode/units/:unitCode/base-ack', auth, async (req) => {
    const r = await acknowledgeBase(ctx, req.params.eventId, actor(req), req.params.projectCode, parseUnit(req.params.unitCode), body(req));
    return { ...r.body, replayed: r.replayed };
  });

  /** 管理员代录：与领导端同一事务和校验，必须填写原因 */
  api.post<{ Params: P }>('/admin/events/:eventId/projects/:projectCode/units/:unitCode/bids', auth, async (req, reply) => {
    const r = await submitBid(ctx, req.params.eventId, actor(req), req.params.projectCode, parseUnit(req.params.unitCode), body(req));
    return reply.status(r.statusCode).send({ receipt: r.body, replayed: r.replayed });
  });

  api.get<{ Params: P }>('/admin/events/:eventId/requests/:key', auth, async (req) =>
    lookupRequest(ctx, idemScope(req.params.eventId, actor(req)), req.params.key),
  );

  // ------------------------------------------------------------ 单位二维码与会话

  api.get<{ Params: P }>('/admin/events/:eventId/units', auth, async (req) => ({ units: await unitAccessStatus(ctx.db, req.params.eventId) }));

  api.post<{ Params: P }>('/admin/events/:eventId/units/:unitCode/credentials', auth, async (req) =>
    issueUnitCredential(ctx, req.params.eventId, actor(req), parseUnit(req.params.unitCode), {
      revokeSessions: body<{ revokeSessions?: boolean }>(req).revokeSessions === true,
    }),
  );

  /** 一次为 16 家生成二维码（用于打印）；会作废此前未使用的二维码 */
  api.post<{ Params: P }>('/admin/events/:eventId/credentials/batch', auth, async (req) => {
    const out = [];
    for (const u of UNITS) out.push(await issueUnitCredential(ctx, req.params.eventId, actor(req), u.code));
    return { credentials: out };
  });

  api.post<{ Params: P }>('/admin/events/:eventId/units/:unitCode/revoke', auth, async (req) =>
    (await revokeUnitSessions(ctx, req.params.eventId, actor(req), parseUnit(req.params.unitCode), String(body(req).reason ?? ''))).body,
  );

  api.get<{ Params: P }>('/admin/events/:eventId/screen-keys', auth, async (req) => ({ keys: await listScreenKeys(ctx.db, req.params.eventId) }));

  api.post<{ Params: P }>('/admin/events/:eventId/screen-keys', auth, async (req) => createScreenKey(ctx, req.params.eventId, actor(req), body(req).label));

  api.post<{ Params: P }>('/admin/events/:eventId/screen-keys/:keyId/revoke', auth, async (req) =>
    (await revokeScreenKey(ctx, req.params.eventId, actor(req), req.params.keyId)).body,
  );

  // ------------------------------------------------------------ 监控与审计

  api.get<{ Params: P }>('/admin/events/:eventId/monitor', auth, async (req) => {
    const eventId = req.params.eventId;
    const connections = hub.stats().filter((c) => c.eventId === eventId);
    const failures = await ctx.db.query('SELECT * FROM failed_submissions WHERE event_id = $1 ORDER BY id DESC LIMIT 50', [eventId]);
    return {
      connections,
      screens: connections.filter((c) => c.role === 'SCREEN').length,
      units: await unitAccessStatus(ctx.db, eventId),
      unitConnections: Object.fromEntries(
        UNITS.map((u) => [u.code, connections.filter((c) => c.role === 'BIDDER' && c.unitCode === u.code).length]),
      ),
      failures: failures.rows.map((f) => ({
        id: Number(f.id),
        projectCode: f.project_code,
        unitCode: f.unit_code,
        actorType: f.actor_type,
        operation: f.operation,
        errorCode: f.error_code,
        message: f.message,
        createdAt: toIso(f.created_at),
      })),
    };
  });

  api.get<{ Params: P; Querystring: { limit?: string; before?: string } }>('/admin/events/:eventId/audit', auth, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const before = req.query.before ? Number(req.query.before) : null;
    const r = await ctx.db.query(
      `SELECT * FROM audit_logs WHERE event_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [req.params.eventId, before, limit],
    );
    return {
      logs: r.rows.map((l) => ({
        id: Number(l.id),
        action: l.action,
        projectCode: l.project_code,
        unitCode: l.unit_code,
        actorType: l.actor_type,
        actorName: l.actor_name,
        reason: l.reason,
        details: l.details,
        eventSequence: l.event_sequence === null ? null : Number(l.event_sequence),
        createdAt: toIso(l.created_at),
      })),
    };
  });

  // ------------------------------------------------------------ 导出与备份

  const CSV_SHEETS: Record<string, string> = {
    'first-round': '首轮结果',
    ledger: '最终竞标台账',
    bids: '加码流水',
    control: '确认与控制记录',
  };

  const logExport = (req: FastifyRequest, eventId: string, format: string, provisional: boolean) =>
    ctx.db.query(
      `INSERT INTO audit_logs (event_id, action, actor_type, actor_id, actor_name, details) VALUES ($1, 'EXPORT', 'ADMIN', $2, $3, $4)`,
      [eventId, req.session!.adminId, req.session!.adminName, JSON.stringify({ format, provisional })],
    );

  api.get<{ Params: P }>('/admin/events/:eventId/exports/ledger.xlsx', auth, async (req, reply) => {
    const data = await withSnapshot(ctx.db, (tx) => collectExport(tx, req.params.eventId));
    await logExport(req, req.params.eventId, 'xlsx', data.provisional);
    const name = `${data.title}-竞标台账${data.provisional ? '（过程数据）' : ''}.xlsx`;
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', attachment(`ledger${data.provisional ? '-provisional' : ''}.xlsx`, name))
      .send(await toXlsx(data));
  });

  api.get<{ Params: P & { sheet: string } }>('/admin/events/:eventId/exports/:sheet.csv', auth, async (req, reply) => {
    const sheetName = CSV_SHEETS[req.params.sheet];
    if (!sheetName) throw bizError('NOT_FOUND', '导出表不存在');
    const data = await withSnapshot(ctx.db, (tx) => collectExport(tx, req.params.eventId));
    await logExport(req, req.params.eventId, `csv:${req.params.sheet}`, data.provisional);
    const name = `${data.title}-${sheetName}${data.provisional ? '（过程数据）' : ''}.csv`;
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', attachment(`${req.params.sheet}${data.provisional ? '-provisional' : ''}.csv`, name))
      .send(toCsv(data, sheetName));
  });

  /** 手动生成检查点（需配置 BACKUP_DIR） */
  api.post<{ Params: P }>('/admin/events/:eventId/checkpoint', auth, async (req) => {
    if (!ctx.config.backupDir || !ctx.onCheckpoint) throw bizError('INVALID_STATE', '服务器未配置 BACKUP_DIR，无法自动备份，请按部署说明手动执行备份脚本');
    ctx.onCheckpoint(req.params.eventId, '手动检查点');
    return { started: true, backupDir: ctx.config.backupDir };
  });

  api.get('/admin/maintenance', auth, async () => {
    const r = await ctx.db.query('SELECT * FROM maintenance_log ORDER BY id DESC LIMIT 50');
    return {
      backupEnabled: !!ctx.config.backupDir,
      readOnly: ctx.config.readOnly,
      logs: r.rows.map((m) => ({ id: Number(m.id), action: m.action, details: m.details, createdAt: toIso(m.created_at) })),
    };
  });

  api.get<{ Params: P }>('/admin/events/:eventId/stream', auth, async (req, reply) => {
    await openStream(hub, req, reply, { role: 'ADMIN', eventId: req.params.eventId, unitCode: null });
  });
}
