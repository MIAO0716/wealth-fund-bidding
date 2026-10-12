/**
 * 调用金山文档 AirScript「同步执行」接口：
 *   POST https://www.kdocs.cn/api/v3/ide/file/{file_id}/script/{script_id}/sync_task
 *   请求头 AirScript-Token: 脚本令牌；请求体 { Context: { argv } }
 *   返回 { status, error, error_details: { msg }, data: { result, logs } }，result 可能是对象或 JSON 字符串
 */

import { KDOCS_PROTOCOL, type KdocsBatchArgv, type KdocsBatchResult } from '@bidding/shared';

export class KdocsError extends Error {
  constructor(
    message: string,
    readonly kind: 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'HTTP' | 'SCRIPT' | 'PROTOCOL',
    readonly status?: number,
  ) {
    super(message);
  }
}

const KDOCS_PATH = /^\/api\/v3\/ide\/file\/[A-Za-z0-9_-]+\/script\/[A-Za-z0-9_-]+\/sync_task$/;

/**
 * 只允许两类地址：金山文档官方（*.kdocs.cn，https）与本机模拟金山文档（127.0.0.1 / localhost 的 /mock-kdocs/）。
 * 返回规范化后的地址；不合法时抛出说明。
 */
export function normalizeWebhookUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请粘贴脚本编辑器中复制的 webhook 链接');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('webhook 链接格式不正确');
  }
  u.hash = '';
  u.search = '';
  if (u.protocol === 'https:' && (u.hostname === 'kdocs.cn' || u.hostname.endsWith('.kdocs.cn'))) {
    if (!KDOCS_PATH.test(u.pathname)) throw new Error('链接应形如 https://www.kdocs.cn/api/v3/ide/file/…/script/…/sync_task');
    return u.toString();
  }
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname.startsWith('/mock-kdocs/')) {
    if (!KDOCS_PATH.test(u.pathname.slice('/mock-kdocs'.length))) throw new Error('模拟金山文档链接格式不正确');
    return u.toString();
  }
  throw new Error('只支持金山文档（kdocs.cn）的脚本 webhook 链接');
}

/** 脚本 1.4.0 起逐项返回写入结果（writeStatus），本机据此确认处理结果已写回表格 */
export const OLD_SCRIPT_MESSAGE =
  '金山表格里的同步脚本版本过旧（需要 1.4.0 及以上）：请在管理端「金山文档」下载最新脚本，在总控文件的脚本编辑器中全选替换并保存，再点「一键连接」';

export function isCurrentScript(r: KdocsBatchResult): boolean {
  return Array.isArray(r.writeStatus);
}

export function isMockUrl(url: string): boolean {
  return url.includes('/mock-kdocs/');
}

export interface CallOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function callScript(
  webhookUrl: string,
  token: string,
  argv: Omit<KdocsBatchArgv, 'protocol'>,
  opts: CallOptions = {},
): Promise<KdocsBatchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  let status = 0;
  let text = '';
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'AirScript-Token': token },
      body: JSON.stringify({ Context: { argv: { protocol: KDOCS_PROTOCOL, ...argv } } }),
      signal: ac.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    if (ac.signal.aborted) throw new KdocsError('金山文档响应超时', 'TIMEOUT');
    throw new KdocsError('无法连接金山文档（请检查本机网络）', 'NETWORK');
  } finally {
    clearTimeout(timer);
  }

  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const errMsg = scriptError(body);
  if (status === 401 || status === 403) throw new KdocsError(errMsg || '脚本令牌无效、已过期或无权运行该脚本', 'AUTH', status);
  if (status === 429) throw new KdocsError('调用过于频繁，金山文档暂时限流（可适当调大同步间隔）', 'HTTP', status);
  if (status < 200 || status >= 300) throw new KdocsError(errMsg || `金山文档返回 HTTP ${status}`, 'HTTP', status);
  if (!body) throw new KdocsError('金山文档返回内容无法解析', 'PROTOCOL', status);
  if (errMsg) {
    if (/云文档/.test(errMsg) && /未添加|未授权|无权限/.test(errMsg)) {
      throw new KdocsError(
        `脚本运行出错：${errMsg}。处理：在脚本编辑器左侧「服务」中确认已添加「云文档API」→ 点工具栏的「保存」→ 在编辑器里点一次「运行」（如弹出授权请允许，日志应显示「云文档API服务可用」）→ 再点「一键连接」。若仍不行，可先改用「一个文件 16 张工作表」`,
        'SCRIPT',
        status,
      );
    }
    throw new KdocsError(`脚本运行出错：${errMsg}`, 'SCRIPT', status);
  }

  let result = body.data?.result;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      throw new KdocsError('脚本返回内容无法解析：请确认粘贴的是管理端下载的完整脚本', 'PROTOCOL', status);
    }
  }
  if (!result || typeof result !== 'object') {
    throw new KdocsError('脚本没有返回结果：请确认粘贴的是管理端下载的完整脚本（末尾应有 return main(Context.argv);）', 'PROTOCOL', status);
  }
  if (result.protocol !== KDOCS_PROTOCOL) {
    throw new KdocsError('脚本版本与本程序不匹配：请从管理端重新下载脚本并整体替换', 'PROTOCOL', status);
  }
  return result as KdocsBatchResult;
}

function scriptError(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const e = typeof body.error === 'string' ? body.error.trim() : '';
  if (e) return e;
  const m = body.error_details?.msg;
  return typeof m === 'string' ? m.trim() : '';
}
