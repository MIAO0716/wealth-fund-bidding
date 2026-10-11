/**
 * 金山文档接入（使用模拟金山文档）：领导在表格中确认底标、填写「加到多少」→ 程序读取 → 大屏更新 → 结果写回表格。
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const H = { 'x-bidding-client': '1' };
// 截图保存到仓库 docs/screenshots（与运行目录无关）
const SHOTS = fileURLToPath(new URL('../../docs/screenshots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const UNITS: Array<[string, number]> = [
  ['PD', 1], ['MH', 1], ['BS', 1], ['JD', 1], ['FX', 1], ['SJ', 1],
  ['HP', 2], ['HK', 2], ['JA', 2], ['PT', 2], ['CN', 2],
  ['XH', 3], ['YP', 3], ['QP', 3], ['JS', 3], ['CM', 3],
];
const MIN: Record<number, number> = { 1: 5, 2: 10, 3: 15 };

test.setTimeout(120_000);

test('领导在（模拟）金山文档中填写：确认底标 → 加码生效 → 大屏同步 → 表格显示结果', async ({ browser, baseURL }) => {
  const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const req = admin.request;
  expect((await req.post('/api/v1/auth/admin/login', { headers: H, data: { username: 'admin', password: 'e2e-password-123' } })).ok()).toBe(true);

  const ev = await (
    await req.post('/api/v1/admin/events', {
      headers: H,
      data: { config: { name: '金山文档演练', eventDate: '2099-12-31', metricName: 'm', amountBasis: '销量', statPeriod: 'p', dataSource: 'E2E' } },
    })
  ).json();
  const eventId: string = ev.event.id;
  const rows = UNITS.map(([u, g]) => ({ projectCode: 'wealth', unitCode: u, baseTargetWan: '1000', firstRoundIncreasePp: u === 'PD' ? 30 : MIN[g] }));
  const v = await (await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/validate`, { headers: H, data: { rows } })).json();
  await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
    headers: H,
    data: { validationId: v.validationId, expectedDraftVersion: v.draftVersion, idempotencyKey: `imp-${eventId}` },
  });
  await req.post(`/api/v1/admin/events/${eventId}/projects/wealth/publish-first-round`, {
    headers: H,
    data: { expectedDraftVersion: 1, idempotencyKey: `pub-${eventId}`, confirm: true },
  });
  const st = await (await req.get(`/api/v1/admin/events/${eventId}/state`)).json();
  await req.post(`/api/v1/admin/events/${eventId}/projects/wealth/control`, {
    headers: H,
    data: { action: 'START', groupNo: 1, expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `start-${eventId}` },
  });

  // 管理端：使用模拟金山文档 → 高级设置中把同步间隔改为 1 秒 → 一键连接
  const page = await admin.newPage();
  await page.goto(`/admin/events/${eventId}/kdocs`);
  await page.getByRole('button', { name: '使用模拟金山文档' }).click();
  await expect(page.getByText('已切换到模拟金山文档')).toBeVisible();
  await page.getByText('高级设置（同步间隔、报价行数、单独执行各步骤）').click();
  await page.getByLabel('同步间隔（秒）').fill('1');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('.notice.success', { hasText: '已保存' })).toBeVisible();
  await page.getByRole('button', { name: '一键连接' }).click();
  for (const step of ['保存链接与令牌', '测试连接', '写入表格版式', '开启同步']) {
    await expect(page.locator('.kd-steps li.ok', { hasText: step })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.locator('.chip', { hasText: '同步中' })).toBeVisible();
  const mockHref = await page.getByRole('link', { name: '打开模拟表格（领导填写页）' }).getAttribute('href');
  const fileId = new URL(mockHref!, baseURL).searchParams.get('file')!;

  // 大屏
  const key = await (await req.post(`/api/v1/admin/events/${eventId}/screen-keys`, { headers: H, data: { label: '主屏' } })).json();
  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screen = await screenCtx.newPage();
  await screen.goto((key.screenUrl as string).replace(/^https?:\/\/[^/]+/, baseURL!).replace('/screen#', '/screen/live#'));
  const pdCurrent = screen.locator('.s-row', { hasText: '浦东' }).locator('.s-current');
  await expect(pdCurrent).toContainText('30');

  // 浦东领导：手机打开本单位工作表
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const sheet = await phone.newPage();
  await sheet.goto(`/mock-kdocs?file=${fileId}&sheet=${encodeURIComponent('浦东')}`);
  const row = (r: number) => sheet.locator('.mk-grid tbody tr').nth(r - 1);
  await expect(row(11)).toContainText('请在 B11 选择「确认」认领理财底标', { timeout: 10_000 });
  await sheet.getByLabel('浦东 B11').selectOption('确认');
  await expect(row(11)).toContainText('已确认（理财', { timeout: 10_000 });

  await sheet.getByLabel('浦东 B13').fill('35');
  await sheet.getByLabel('浦东 B13').press('Enter');
  await expect(row(13)).toContainText('待确认', { timeout: 10_000 });
  const t0 = Date.now();
  await sheet.getByLabel('浦东 C13').selectOption('确认');
  await expect(pdCurrent).toContainText('35', { timeout: 10_000 });
  console.log(`模拟金山文档确认 → 大屏显示 35% 用时 ${Date.now() - t0} ms（同步间隔 1 秒）`);
  await expect(row(13)).toContainText('✔ 已生效：30% → 35%', { timeout: 10_000 });
  await expect(row(8)).toContainText('35%');
  await sheet.screenshot({ path: `${SHOTS}/kdocs-mock-sheet.png` });

  // 填低了：不生效
  await sheet.getByLabel('浦东 B14').fill('30');
  await sheet.getByLabel('浦东 B14').press('Enter');
  await sheet.getByLabel('浦东 C14').selectOption('确认');
  await expect(row(14)).toContainText('✘ 未生效', { timeout: 10_000 });
  await expect(pdCurrent).toContainText('35');

  // 管理端看到处理记录；现场控制中来源标注「金山文档」
  await expect(page.getByText('已生效 1 · 未生效 1')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/kdocs-admin.png`, fullPage: true });
  await page.goto(`/admin/events/${eventId}/control`);
  await expect(page.locator('.chip', { hasText: '金山文档' }).first()).toBeVisible();

  await Promise.all([admin.close(), screenCtx.close(), phone.close()]);
});
