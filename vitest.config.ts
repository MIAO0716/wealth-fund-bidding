import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    // 服务端测试共用一个测试数据库，按文件串行执行
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
