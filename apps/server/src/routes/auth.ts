import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { COOKIE_NAMES, adminLogin, exchangeScreenKey, exchangeUnitCredential, getSession, revokeSessionById } from '../services/auth';

export function registerAuthRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, cookieOptions } = deps;

  api.post('/auth/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const r = await adminLogin(ctx, body.username, body.password, req.headers['user-agent']);
    reply.setCookie(COOKIE_NAMES.ADMIN, r.token, cookieOptions(r.expiresAt));
    return { admin: r.admin, expiresAt: r.expiresAt.toISOString() };
  });

  api.post('/auth/admin/logout', async (req, reply) => {
    const s = await getSession(ctx.db, 'ADMIN', req.cookies[COOKIE_NAMES.ADMIN]);
    if (s) await revokeSessionById(ctx.db, s.id, '退出登录');
    reply.clearCookie(COOKIE_NAMES.ADMIN, { path: '/' });
    return { ok: true };
  });

  api.get('/auth/admin/me', { preHandler: deps.requireRole('ADMIN') }, async (req) => ({
    admin: { id: req.session!.adminId, displayName: req.session!.adminName },
    readOnly: ctx.config.readOnly,
    publicBaseUrl: ctx.config.publicBaseUrl,
  }));

  /** 领导扫码：一次性凭证换取单位会话，前端随后从地址栏移除凭证 */
  api.post('/auth/bidder/exchange', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: unknown };
    const r = await exchangeUnitCredential(ctx, body.token, req.headers['user-agent']);
    reply.setCookie(COOKIE_NAMES.BIDDER, r.token, cookieOptions(r.expiresAt));
    return { eventId: r.eventId, unitCode: r.unitCode, expiresAt: r.expiresAt.toISOString() };
  });

  api.post('/auth/screen/exchange', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown };
    const r = await exchangeScreenKey(ctx, body.key, req.headers['user-agent']);
    reply.setCookie(COOKIE_NAMES.SCREEN, r.token, cookieOptions(r.expiresAt));
    return { eventId: r.eventId, expiresAt: r.expiresAt.toISOString() };
  });
}
