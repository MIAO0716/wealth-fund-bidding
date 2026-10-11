import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Ctx, setup } from './helpers';

// 前端构建产物托管：升级后浏览器不会用旧页面去加载已不存在的脚本而一片空白
let ctx: Ctx;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">页面加载中</div><script type="module" src="/assets/index-abc.js"></script>');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  ctx = await setup({ webDist: dir });
});
afterAll(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('前端页面托管', () => {
  it('页面每次向服务器确认（no-cache），带哈希的脚本长期缓存', async () => {
    const page = await ctx.app.inject({ method: 'GET', url: '/admin' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-cache');
    const js = await ctx.app.inject({ method: 'GET', url: '/assets/index-abc.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('旧版本的脚本已不存在：返回 404，而不是把页面当脚本返回', async () => {
    const old = await ctx.app.inject({ method: 'GET', url: '/assets/index-old.js' });
    expect(old.statusCode).toBe(404);
    expect(old.headers['content-type']).not.toContain('text/html');
    const api = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(api.statusCode).toBe(404);
  });
});
