/**
 * 简单的内存限流：用于登录、扫码换会话等公网暴露的入口，防止暴力尝试。
 * 单进程部署足够；进程重启后计数清零。
 */

export class FailureLimiter {
  private hits = new Map<string, { count: number; first: number; blockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly blockMs: number,
  ) {}

  /** 返回剩余封禁毫秒数；0 表示可以尝试 */
  blockedFor(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h) return 0;
    if (h.blockedUntil > now) return h.blockedUntil - now;
    if (now - h.first > this.windowMs) this.hits.delete(key);
    return 0;
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || now - h.first > this.windowMs) {
      this.hits.set(key, { count: 1, first: now, blockedUntil: 0 });
      return;
    }
    h.count++;
    if (h.count >= this.maxFailures) h.blockedUntil = now + this.blockMs;
    this.prune(now);
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (now - v.first > this.windowMs && v.blockedUntil < now) this.hits.delete(k);
  }
}
