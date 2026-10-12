import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app';
import { BizError, bizError } from '../lib/errors';
import { FailureLimiter } from '../lib/ratelimit';
import { COOKIE_NAMES, adminLogin, exchangeScreenKey, exchangeUnitCredential, getSession, revokeSessionById } from '../services/auth';

async function limited<T>(limiters: Array<[FailureLimiter, string]>, fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(...limiters.map(([l, k]) => l.blockedFor(k)));
  if (wait > 0) throw bizError('TOO_MANY_ATTEMPTS', `尝试次数过多，请 ${Math.ceil(wait / 60_000)} 分钟后再试`);
  try {
    const r = await fn();
    for (const [l, k] of limiters) l.succeed(k);
    return r;
  } catch (e) {
    if (e instanceof BizError && (e.code === 'UNAUTHORIZED' || e.code === 'CREDENTIAL_INVALID')) {
      for (const [l, k] of limiters) l.fail(k);
    }
    throw e;
  }
}

const ipOf = (req: FastifyRequest) => req.ip;

export function registerAuthRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { ctx, cookieOptions } = deps;
  // 管理员登录：同一账号 15 分钟内失败 5 次封禁 15 分钟；同一 IP 放宽到 20 次（会场多人可能共用一个出口 IP）
  const loginByUser = new FailureLimiter(5, 15 * 60_000, 15 * 60_000);
  const loginByIp = new FailureLimiter(20, 15 * 60_000, 15 * 60_000);
  // 扫码/大屏凭证：同一 IP 10 分钟内失败 20 次封禁 10 分钟（凭证为 256 位随机数，主要防滥用）
  const credentialByIp = new FailureLimiter(20, 10 * 60_000, 10 * 60_000);

  api.post('/auth/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const user = typeof body.username === 'string' ? body.username.slice(0, 64) : '';
    const r = await limited([[loginByIp, ipOf(req)], [loginByUser, user]], () =>
      adminLogin(ctx, body.username, body.password, req.headers['user-agent']),
    );
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

  /** 领导扫码：凭证换取单位会话（可重复扫码，新登录让旧手机下线），前端随后从地址栏移除凭证 */
  api.post('/auth/bidder/exchange', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: unknown };
    const r = await limited([[credentialByIp, ipOf(req)]], () => exchangeUnitCredential(ctx, body.token, req.headers['user-agent']));
    reply.setCookie(COOKIE_NAMES.BIDDER, r.token, cookieOptions(r.expiresAt));
    return { eventId: r.eventId, unitCode: r.unitCode, expiresAt: r.expiresAt.toISOString() };
  });

  api.post('/auth/screen/exchange', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown };
    const r = await limited([[credentialByIp, ipOf(req)]], () => exchangeScreenKey(ctx, body.key, req.headers['user-agent']));
    reply.setCookie(COOKIE_NAMES.SCREEN, r.token, cookieOptions(r.expiresAt));
    return { eventId: r.eventId, expiresAt: r.expiresAt.toISOString() };
  });
}
