import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig } from './config';
import { type Db, createPool } from './db/pool';
import { BizError, bizError } from './lib/errors';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerKdocsAdminRoutes, registerKdocsMockApi, registerKdocsMockRoutes } from './routes/kdocs';
import { registerBidderRoutes } from './routes/bidder';
import { registerScreenRoutes } from './routes/screen';
import { COOKIE_NAMES, type Role, type SessionInfo, getSession } from './services/auth';
import { makeCheckpointer } from './services/backup';
import type { AppContext } from './services/context';
import type { KdocsDeps } from './services/kdocs/admin';
import { KdocsMock } from './services/kdocs/mock';
import { KdocsSyncManager } from './services/kdocs/sync';
import { RealtimeHub } from './services/realtime';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionInfo;
  }
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  hub: RealtimeHub;
  db: Db;
  kdocs: KdocsDeps;
}

export interface AppDeps {
  ctx: AppContext;
  hub: RealtimeHub;
  kdocs: KdocsDeps;
  requireRole: (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  cookieOptions: (expiresAt: Date) => { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; expires: Date };
}

export async function buildApp(config: AppConfig, opts: { db?: Db; logger?: boolean } = {}): Promise<BuiltApp> {
  const db = opts.db ?? createPool(config.databaseUrl);
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            // 凭证、会话不得出现在日志中
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          },
  });
  const log = (msg: string, err?: unknown) => (err ? app.log.error({ err }, msg) : app.log.info(msg));
  const ctx: AppContext = { db, config, log, onCheckpoint: makeCheckpointer(config, db, log) };
  const hub = new RealtimeHub(db, config.databaseUrl, log);
  const kdocs: KdocsDeps = { ctx, sync: new KdocsSyncManager(ctx, log), mock: config.kdocsMock ? new KdocsMock() : null };

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof BizError) return reply.status(err.status).send(err.toBody());
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message ?? '请求格式不正确' } });
    }
    req.log.error({ err }, '未处理的服务器错误');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误，请联系工作人员' } });
  });

  // 写请求必须带自定义请求头：跨站表单无法伪造，跨域 fetch 会被同源策略拦截
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (req.headers['x-bidding-client'] !== '1') throw bizError('FORBIDDEN', '缺少客户端标识请求头');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // 页面只加载本站资源；二维码为 data: 图片；SSE/接口同源
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    // HTTPS 部署：强制浏览器之后只用 HTTPS 访问
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });

  const requireRole = (role: Role) => async (req: FastifyRequest) => {
    const token = req.cookies[COOKIE_NAMES[role]];
    const s = await getSession(db, role, token);
    if (!s) throw bizError(role === 'BIDDER' ? 'SESSION_INVALID' : 'UNAUTHORIZED', role === 'SCREEN' ? '大屏凭证无效，请重新打开大屏链接' : undefined);
    const eventId = (req.params as { eventId?: string } | undefined)?.eventId;
    // 领导与大屏会话只绑定一个活动，不能读写其他活动
    if (eventId && role !== 'ADMIN' && s.eventId !== eventId) throw bizError(role === 'BIDDER' ? 'SESSION_INVALID' : 'FORBIDDEN');
    req.session = s;
  };

  const cookieOptions = (expiresAt: Date) => ({
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  });

  const deps: AppDeps = { ctx, hub, kdocs, requireRole, cookieOptions };

  app.get('/healthz', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', readOnly: config.readOnly, time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'db_unavailable' });
    }
  });

  await app.register(
    async (api) => {
      registerAuthRoutes(api, deps);
      registerAdminRoutes(api, deps);
      registerBidderRoutes(api, deps);
      registerScreenRoutes(api, deps);
      registerKdocsAdminRoutes(api, deps);
      registerKdocsMockApi(api, deps);
    },
    { prefix: '/api/v1' },
  );
  registerKdocsMockRoutes(app, deps);

  // 生产：同域托管前端构建产物（SPA 回退到 index.html）
  const webDist = config.webDist ? resolve(config.webDist) : '';
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // 带哈希的构建产物可长期缓存；页面本身每次都向服务器确认，升级后不会继续用旧页面去加载已不存在的脚本
      setHeaders: (reply, path) => {
        reply.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // 接口与缺失的构建产物返回 404（不能回退成页面：浏览器会把 HTML 当脚本加载失败，管理端一片空白）
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/') || req.method !== 'GET') {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: req.url.startsWith('/api/') ? '接口不存在' : '文件不存在' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
  }

  app.addHook('onClose', async () => {
    kdocs.sync.stop();
    await hub.stop();
    if (!opts.db) await db.end();
  });

  return { app, ctx, hub, db, kdocs };
}
