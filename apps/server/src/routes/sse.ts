import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../services/auth';
import type { RealtimeHub } from '../services/realtime';

/** 建立 SSE 长连接。since 来自查询参数（快照序列）或 Last-Event-ID（断线重连） */
export async function openStream(
  hub: RealtimeHub,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { role: Role; eventId: string; unitCode: string | null },
): Promise<void> {
  const q = req.query as { since?: string };
  const lastEventId = req.headers['last-event-id'];
  const sinceRaw = (typeof lastEventId === 'string' && lastEventId) || q.since || '0';
  const since = Number.isFinite(Number(sinceRaw)) && Number(sinceRaw) >= 0 ? Math.floor(Number(sinceRaw)) : 0;

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关闭 Nginx 等反向代理缓冲
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let closed = false;
  const send = (event: string, data: unknown, id?: number) => {
    if (closed) return;
    let chunk = '';
    if (id !== undefined) chunk += `id: ${id}\n`;
    chunk += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(chunk);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    res.end();
  };
  const sub = await hub.subscribe({ role: opts.role, eventId: opts.eventId, unitCode: opts.unitCode, since, send, close });
  req.raw.on('close', () => {
    closed = true;
    hub.unsubscribe(sub);
  });
}
