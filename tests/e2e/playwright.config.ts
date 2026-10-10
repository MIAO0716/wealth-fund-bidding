import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 18090);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    // 失败时保留现场（测试库的临时凭证，不含正式数据）
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === '/opt/pw-browsers'
      ? { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }
      : {},
  },
  // 需先执行 npm run build；E2E 使用独立数据库（会被清空）
  webServer: {
    command: 'node tests/e2e/prepare.mjs && node apps/server/dist/main.js',
    cwd: '../..',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://bid:bid@localhost:5432/bidding_e2e',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: BASE_URL,
      WEB_DIST: 'apps/web/dist',
      LOG_LEVEL: 'warn',
      ADMIN_PASSWORD: 'e2e-password-123',
    },
  },
});
