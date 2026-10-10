/**
 * 身份与会话：
 * - 管理员：账号密码登录（密码 scrypt 哈希，不硬编码）。
 * - 领导：管理员发放的专属二维码含一次性交换凭证，交换后得到仅绑定本活动、本单位的会话；默认一个单位一个有效会话。
 * - 大屏：独立只读凭证，可多块屏共用，可撤销。
 * 数据库只保存凭证与会话的哈希。
 */

import { UNIT_BY_CODE } from '@bidding/shared';
import QRCode from 'qrcode';
import type { Queryable } from '../db/pool';
import { hashPassword, randomToken, sha256, uuid, verifyPassword } from '../lib/crypto';
import { bizError } from '../lib/errors';
import { endOfShanghaiDay, toIso } from '../lib/time';
import { type Actor, audit, emit } from './core';
import { type AppContext, runWrite } from './context';
import { readConfig } from './events';

export type Role = 'BIDDER' | 'SCREEN' | 'ADMIN';

export const COOKIE_NAMES: Record<Role, string> = {
  ADMIN: 'bid_admin',
  BIDDER: 'bid_unit',
  SCREEN: 'bid_screen',
};

export interface SessionInfo {
  id: string;
  role: Role;
  eventId: string | null;
  unitCode: string | null;
  adminId: string | null;
  adminName: string | null;
  expiresAt: Date;
}

export function actorOf(s: SessionInfo): Actor {
  if (s.role === 'ADMIN') return { type: 'ADMIN', id: s.adminId!, name: s.adminName ?? '管理员' };
  if (s.role === 'BIDDER') {
    const unit = UNIT_BY_CODE.get(s.unitCode!);
    return { type: 'LEADER', id: s.unitCode!, name: `${unit?.name ?? s.unitCode}领导`, unitCode: s.unitCode! };
  }
  return { type: 'SYSTEM', id: 'screen', name: '大屏' };
}

async function createSession(
  q: Queryable,
  opts: { role: Role; eventId?: string | null; unitCode?: string | null; adminId?: string | null; credentialId?: string | null; expiresAt: Date; userAgent?: string | null },
): Promise<{ token: string; id: string }> {
  const token = randomToken();
  const id = uuid();
  await q.query(
    `INSERT INTO sessions (id, token_hash, role, event_id, unit_code, admin_id, credential_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, sha256(token), opts.role, opts.eventId ?? null, opts.unitCode ?? null, opts.adminId ?? null, opts.credentialId ?? null, opts.expiresAt, opts.userAgent?.slice(0, 300) ?? null],
  );
  return { token, id };
}

/** 读取并校验会话；无效返回 null */
export async function getSession(q: Queryable, role: Role, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const r = await q.query(
    `SELECT s.*, a.display_name AS admin_name, a.disabled AS admin_disabled, k.revoked_at AS key_revoked_at
       FROM sessions s
       LEFT JOIN admins a ON a.id = s.admin_id
       LEFT JOIN screen_keys k ON s.role = 'SCREEN' AND k.id = s.credential_id
      WHERE s.token_hash = $1 AND s.role = $2`,
    [sha256(token), role],
  );
  if (!r.rowCount) return null;
  const s = r.rows[0];
  if (s.revoked_at || new Date(s.expires_at).getTime() <= Date.now()) return null;
  if (s.admin_disabled || s.key_revoked_at) return null;
  // 节流更新最近活跃时间
  if (Date.now() - new Date(s.last_seen_at).getTime() > 30_000) {
    q.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]).catch(() => {});
  }
  return {
    id: s.id,
    role: s.role,
    eventId: s.event_id,
    unitCode: s.unit_code,
    adminId: s.admin_id,
    adminName: s.admin_name,
    expiresAt: new Date(s.expires_at),
  };
}

export async function revokeSessionById(q: Queryable, id: string, reason: string): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [id, reason]);
}

// ---------------------------------------------------------------- 管理员

export async function createAdmin(q: Queryable, username: string, displayName: string, password: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error('用户名须为 3–32 位字母、数字或 _.-');
  if (password.length < 10) throw new Error('密码至少 10 位');
  const id = uuid();
  await q.query(
    `INSERT INTO admins (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name, disabled = false`,
    [id, username, displayName, await hashPassword(password)],
  );
  const r = await q.query('SELECT id FROM admins WHERE username = $1', [username]);
  return r.rows[0].id;
}

export async function adminLogin(ctx: AppContext, username: unknown, password: unknown, userAgent?: string) {
  if (typeof username !== 'string' || typeof password !== 'string') throw bizError('UNAUTHORIZED', '请输入账号和密码');
  const r = await ctx.db.query('SELECT * FROM admins WHERE username = $1', [username]);
  const admin = r.rows[0];
  // 无论账号是否存在都做一次哈希比较，避免通过耗时探测账号
  const ok = admin
    ? await verifyPassword(password, admin.password_hash)
    : await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!admin || !ok || admin.disabled) throw bizError('UNAUTHORIZED', '账号或密码错误');
  const expiresAt = new Date(Date.now() + ctx.config.adminSessionHours * 3600_000);
  const { token } = await createSession(ctx.db, { role: 'ADMIN', adminId: admin.id, expiresAt, userAgent });
  await ctx.db.query(
    `INSERT INTO audit_logs (action, actor_type, actor_id, actor_name) VALUES ('ADMIN_LOGIN', 'ADMIN', $1, $2)`,
    [admin.id, admin.display_name],
  );
  return { token, expiresAt, admin: { id: admin.id, username: admin.username, displayName: admin.display_name } };
}

// ---------------------------------------------------------------- 领导二维码

function bidderSessionExpiry(eventDate: string | null): Date {
  const end = eventDate ? endOfShanghaiDay(eventDate) : null;
  const fallback = new Date(Date.now() + 24 * 3600_000);
  // 覆盖活动当天；活动日已过或未配置时给 24 小时
  if (!end || end.getTime() < Date.now()) return fallback;
  return end;
}

export function joinUrl(publicBaseUrl: string, token: string): string {
  // 凭证放在 # 片段中：不会发送到服务器日志、反向代理日志或 Referer
  return `${publicBaseUrl}/join#t=${token}`;
}

export function screenUrl(publicBaseUrl: string, token: string, path = '/screen'): string {
  return `${publicBaseUrl}${path}#k=${token}`;
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
}

export interface IssuedCredential {
  unitCode: string;
  unitName: string;
  joinUrl: string;
  qrDataUrl: string;
  expiresAt: string;
}

/** 为单位（重新）发放二维码：作废该单位此前未使用的凭证；可选同时撤销现有会话 */
export async function issueUnitCredential(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  unitCode: string,
  opts: { revokeSessions?: boolean } = {},
) {
  const unit = UNIT_BY_CODE.get(unitCode);
  if (!unit) throw bizError('NOT_FOUND', '单位不存在');
  const token = randomToken();
  const res = await runWrite(ctx, eventId, actor, { operation: 'ISSUE_CREDENTIAL' }, async (tx, ev) => {
    const cfg = readConfig(ev);
    const expiresAt = new Date(Date.now() + cfg.qrValidHours * 3600_000);
    await tx.query(
      `UPDATE unit_credentials SET revoked_at = now() WHERE event_id = $1 AND unit_code = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [eventId, unitCode],
    );
    if (opts.revokeSessions) {
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = '管理员重新发放二维码'
          WHERE event_id = $1 AND unit_code = $2 AND role = 'BIDDER' AND revoked_at IS NULL`,
        [eventId, unitCode],
      );
    }
    await tx.query(
      `INSERT INTO unit_credentials (id, event_id, unit_code, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuid(), eventId, unitCode, sha256(token), expiresAt, actor.id],
    );
    const seq = await emit(tx, eventId, { type: 'SESSION_CHANGED', audience: 'ADMIN', unitCode, data: { action: 'ISSUED' } });
    await audit(tx, eventId, actor, 'CREDENTIAL_ISSUED', {
      unitCode,
      details: { revokeSessions: !!opts.revokeSessions, expiresAt: expiresAt.toISOString() },
      eventSequence: seq,
    });
    return { body: { expiresAt } };
  });
  const url = joinUrl(ctx.config.publicBaseUrl, token);
  return {
    unitCode,
    unitName: unit.name,
    joinUrl: url,
    qrDataUrl: await qrDataUrl(url),
    expiresAt: res.body.expiresAt.toISOString(),
  } satisfies IssuedCredential;
}

export async function revokeUnitSessions(ctx: AppContext, eventId: string, actor: Actor, unitCode: string, reason: string) {
  if (!UNIT_BY_CODE.has(unitCode)) throw bizError('NOT_FOUND', '单位不存在');
  return runWrite(ctx, eventId, actor, { operation: 'REVOKE_UNIT' }, async (tx) => {
    const s = await tx.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
        WHERE event_id = $1 AND unit_code = $2 AND role = 'BIDDER' AND revoked_at IS NULL`,
      [eventId, unitCode, reason || '管理员撤销'],
    );
    const c = await tx.query(
      `UPDATE unit_credentials SET revoked_at = now() WHERE event_id = $1 AND unit_code = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [eventId, unitCode],
    );
    const seq = await emit(tx, eventId, { type: 'SESSION_CHANGED', audience: 'ADMIN', unitCode, data: { action: 'REVOKED' } });
    await audit(tx, eventId, actor, 'UNIT_SESSIONS_REVOKED', {
      unitCode,
      reason: reason || null,
      details: { sessions: s.rowCount, credentials: c.rowCount },
      eventSequence: seq,
    });
    return { body: { revokedSessions: s.rowCount ?? 0, revokedCredentials: c.rowCount ?? 0 } };
  });
}

/** 领导扫码：一次性凭证换取单位会话 */
export async function exchangeUnitCredential(ctx: AppContext, token: unknown, userAgent?: string) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw bizError('CREDENTIAL_INVALID');
  if (ctx.config.readOnly) throw bizError('READ_ONLY');
  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT event_id FROM unit_credentials WHERE token_hash = $1', [sha256(token)]);
    if (!found.rowCount) throw bizError('CREDENTIAL_INVALID');
    // 锁顺序与其他写操作一致：先活动行，再凭证行
    const ev = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [found.rows[0].event_id]);
    const r = await client.query('SELECT * FROM unit_credentials WHERE token_hash = $1 FOR UPDATE', [sha256(token)]);
    const cred = r.rows[0];
    if (!cred || cred.used_at || cred.revoked_at || new Date(cred.expires_at).getTime() <= Date.now()) {
      throw bizError('CREDENTIAL_INVALID');
    }
    const cfg = readConfig(ev.rows[0]);
    await client.query('UPDATE unit_credentials SET used_at = now() WHERE id = $1', [cred.id]);
    // 默认一个单位一个有效会话
    await client.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = '同单位新会话登录'
        WHERE event_id = $1 AND unit_code = $2 AND role = 'BIDDER' AND revoked_at IS NULL`,
      [cred.event_id, cred.unit_code],
    );
    const expiresAt = bidderSessionExpiry(cfg.eventDate);
    const s = await createSession(client, {
      role: 'BIDDER',
      eventId: cred.event_id,
      unitCode: cred.unit_code,
      credentialId: cred.id,
      expiresAt,
      userAgent,
    });
    const actor: Actor = { type: 'LEADER', id: cred.unit_code, name: `${UNIT_BY_CODE.get(cred.unit_code)?.name}领导`, unitCode: cred.unit_code };
    const seq = await emit(client, cred.event_id, { type: 'SESSION_CHANGED', audience: 'ADMIN', unitCode: cred.unit_code, data: { action: 'JOINED' } });
    await audit(client, cred.event_id, actor, 'UNIT_JOINED', { unitCode: cred.unit_code, eventSequence: seq });
    await client.query('COMMIT');
    return { token: s.token, expiresAt, eventId: cred.event_id as string, unitCode: cred.unit_code as string };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- 大屏凭证

export async function createScreenKey(ctx: AppContext, eventId: string, actor: Actor, label: unknown) {
  const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 50) : '大屏';
  const token = randomToken();
  const id = uuid();
  await runWrite(ctx, eventId, actor, { operation: 'SCREEN_KEY' }, async (tx) => {
    await tx.query(
      'INSERT INTO screen_keys (id, event_id, label, token_hash, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, eventId, name, sha256(token), actor.id],
    );
    await audit(tx, eventId, actor, 'SCREEN_KEY_CREATED', { details: { id, label: name } });
    return { body: null };
  });
  const url = screenUrl(ctx.config.publicBaseUrl, token);
  return { id, label: name, screenUrl: url, qrDataUrl: await qrDataUrl(url) };
}

export async function revokeScreenKey(ctx: AppContext, eventId: string, actor: Actor, keyId: string) {
  return runWrite(ctx, eventId, actor, { operation: 'SCREEN_KEY_REVOKE' }, async (tx) => {
    const r = await tx.query('UPDATE screen_keys SET revoked_at = now() WHERE id = $1 AND event_id = $2 AND revoked_at IS NULL', [keyId, eventId]);
    if (!r.rowCount) throw bizError('NOT_FOUND', '大屏凭证不存在或已撤销');
    await audit(tx, eventId, actor, 'SCREEN_KEY_REVOKED', { details: { id: keyId } });
    return { body: { revoked: true } };
  });
}

export async function listScreenKeys(q: Queryable, eventId: string) {
  const r = await q.query('SELECT id, label, revoked_at, created_at FROM screen_keys WHERE event_id = $1 ORDER BY created_at', [eventId]);
  return r.rows.map((k) => ({ id: k.id, label: k.label, revokedAt: toIso(k.revoked_at), createdAt: toIso(k.created_at) }));
}

export async function exchangeScreenKey(ctx: AppContext, key: unknown, userAgent?: string) {
  if (typeof key !== 'string' || key.length < 20 || key.length > 200) throw bizError('CREDENTIAL_INVALID', '大屏凭证无效');
  const r = await ctx.db.query('SELECT * FROM screen_keys WHERE token_hash = $1', [sha256(key)]);
  const k = r.rows[0];
  if (!k || k.revoked_at) throw bizError('CREDENTIAL_INVALID', '大屏凭证无效或已撤销');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
  const s = await createSession(ctx.db, { role: 'SCREEN', eventId: k.event_id, credentialId: k.id, expiresAt, userAgent });
  return { token: s.token, expiresAt, eventId: k.event_id as string };
}

// ---------------------------------------------------------------- 单位会话状态（管理端）

export async function unitAccessStatus(q: Queryable, eventId: string) {
  const creds = await q.query(
    `SELECT DISTINCT ON (unit_code) unit_code, created_at, expires_at, used_at, revoked_at
       FROM unit_credentials WHERE event_id = $1 ORDER BY unit_code, created_at DESC`,
    [eventId],
  );
  const sessions = await q.query(
    `SELECT unit_code, count(*)::int AS active, max(last_seen_at) AS last_seen
       FROM sessions WHERE event_id = $1 AND role = 'BIDDER' AND revoked_at IS NULL AND expires_at > now()
      GROUP BY unit_code`,
    [eventId],
  );
  const credMap = new Map(creds.rows.map((c) => [c.unit_code, c]));
  const sesMap = new Map(sessions.rows.map((s) => [s.unit_code, s]));
  return [...UNIT_BY_CODE.values()].map((u) => {
    const c = credMap.get(u.code);
    const s = sesMap.get(u.code);
    let credentialStatus: 'NONE' | 'ISSUED' | 'USED' | 'EXPIRED' | 'REVOKED' = 'NONE';
    if (c) {
      if (c.used_at) credentialStatus = 'USED';
      else if (c.revoked_at) credentialStatus = 'REVOKED';
      else if (new Date(c.expires_at).getTime() <= Date.now()) credentialStatus = 'EXPIRED';
      else credentialStatus = 'ISSUED';
    }
    return {
      unitCode: u.code,
      unitName: u.name,
      groupNo: u.groupNo,
      credentialStatus,
      credentialIssuedAt: toIso(c?.created_at),
      credentialExpiresAt: toIso(c?.expires_at),
      credentialUsedAt: toIso(c?.used_at),
      activeSessions: s?.active ?? 0,
      lastSeenAt: toIso(s?.last_seen),
    };
  });
}
