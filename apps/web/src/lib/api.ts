import { ERROR_MESSAGES, type ErrorCode } from '@bidding/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK' | 'TIMEOUT',
    message: string,
    readonly details?: any,
  ) {
    super(message);
  }

  /** 网络中断或超时：结果未知，需要核验 */
  get uncertain(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.status >= 502;
  }
}

export interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), opts.timeoutMs ?? 10_000);
  opts.signal?.addEventListener('abort', () => ac.abort());
  let res: Response;
  try {
    const isForm = opts.body instanceof FormData;
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-bidding-client': '1',
        ...(opts.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    if (ac.signal.aborted && ac.signal.reason === 'timeout') throw new ApiError(0, 'TIMEOUT', '网络超时，结果待核验');
    throw new ApiError(0, 'NETWORK', '网络连接异常');
  }
  clearTimeout(timer);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error;
    const code = (err?.code ?? 'INTERNAL') as ErrorCode;
    throw new ApiError(res.status, code, err?.message ?? ERROR_MESSAGES[code] ?? `请求失败（${res.status}）`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, opts?: RequestOptions) => request<T>('GET', url, opts),
  post: <T = any>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', url, { ...opts, body: body ?? {} }),
  put: <T = any>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', url, { ...opts, body: body ?? {} }),
  patch: <T = any>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', url, { ...opts, body: body ?? {} }),
};

export function newIdempotencyKey(prefix = 'r'): string {
  // 局域网 http 部署不是安全上下文，crypto.randomUUID 不可用；getRandomValues 始终可用
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return (e as Error)?.message ?? '操作失败';
}

/** 从 URL 片段读取凭证后立即从地址栏移除 */
export function takeHashParam(name: string): string | null {
  const m = new RegExp(`[#&]${name}=([^&]+)`).exec(window.location.hash);
  if (!m) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return decodeURIComponent(m[1]);
}
