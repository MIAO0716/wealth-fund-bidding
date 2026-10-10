import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** 模拟服务端：先给响应头，正文按 parts 逐段发送；stall 为 true 时之后不再结束 */
function mockFetch(opts: { status?: number; parts?: string[]; stall?: boolean; failAfterParts?: boolean }) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of opts.parts ?? []) controller.enqueue(new TextEncoder().encode(p));
        if (opts.failAfterParts) controller.error(new TypeError('network error'));
        else if (!opts.stall) controller.close();
        signal?.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('应当失败');
}

describe('FIX-05 请求超时覆盖响应正文', () => {
  it('响应头已到、正文停滞：按超时结束并标记待核验', async () => {
    mockFetch({ parts: ['{"ok":'], stall: true });
    const started = Date.now();
    const e = await errorOf(api.post('/x', {}, { timeoutMs: 200 }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('TIMEOUT');
    expect(e.uncertain).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('正文中途断开：网络异常，待核验', async () => {
    mockFetch({ status: 201, parts: ['{"receipt":'], failAfterParts: true });
    const e = await errorOf(api.post('/x', {}));
    expect(e.code).toBe('NETWORK');
    expect(e.uncertain).toBe(true);
  });

  it('普通网络错误', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const e = await errorOf(api.get('/x'));
    expect(e.code).toBe('NETWORK');
  });

  it('业务错误保持错误码与提示，不属于待核验', async () => {
    mockFetch({ status: 409, parts: ['{"error":{"code":"VERSION_CONFLICT","message":"已被更新"}}'] });
    const e = await errorOf(api.post('/x', {}));
    expect(e.status).toBe(409);
    expect(e.code).toBe('VERSION_CONFLICT');
    expect(e.message).toBe('已被更新');
    expect(e.uncertain).toBe(false);
  });

  it('正常响应；结束后不遗留计时器', async () => {
    vi.useFakeTimers();
    mockFetch({ parts: ['{"a":', '1}'] });
    await expect(api.get('/x')).resolves.toEqual({ a: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
