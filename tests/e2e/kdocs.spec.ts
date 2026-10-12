/**
 * 金山文档接入（使用模拟金山文档）：领导在「我要加到」填一个数字（首次填写即确认底标）→ 程序读取 → 大屏更新 → 结果写回表格。
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

test('领导在（模拟）金山文档中只填一个格子：加码生效（同时认领底标）→ 大屏同步 → 表格显示结果', async ({ browser, baseURL }) => {
  const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const req = admin.request;
  expect((await req.post('/api/v1/auth/admin/login', { headers: H, data: { username: 'admin', password: 'e2e-password-123' } })).ok()).toBe(true);

  // 模拟金山文档只能用于演示活动
  const ev = await (await req.post('/api/v1/admin/events', { headers: H, data: { isDemo: true } })).json();
  const eventId: string = ev.event.id;
  const rows = UNITS.map(([u, g]) => ({ projectCode: 'wealth', unitCode: u, baseTargetWan: '1000', firstRoundIncreasePp: u === 'PD' ? 30 : MIN[g] }));
  const v = await (await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/validate`, { headers: H, data: { rows } })).json();
  await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
    headers: H,
    data: { validationId: v.validationId, expectedDraftVersion: v.draftVersion, idempotencyKey: `imp-${eventId}` },
  });
  const fr = await (await req.get(`/api/v1/admin/events/${eventId}/first-round`)).json();
  const pub = await req.post(`/api/v1/admin/events/${eventId}/projects/wealth/publish-first-round`, {
    headers: H,
    data: { expectedDraftVersion: fr.projects.wealth.project.draftVersion, idempotencyKey: `pub-${eventId}`, confirm: true },
  });
  expect(pub.ok()).toBe(true);
  const st = await (await req.get(`/api/v1/admin/events/${eventId}/state`)).json();
  await req.post(`/api/v1/admin/events/${eventId}/projects/wealth/control`, {
    headers: H,
    data: { action: 'START', groupNo: 1, expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `start-${eventId}` },
  });

  // 管理端：使用模拟金山文档 → 一键连接（默认手动读取）
  const page = await admin.newPage();
  await page.goto(`/admin/events/${eventId}/kdocs`);
  await page.getByRole('button', { name: '使用模拟金山文档' }).click();
  await expect(page.getByText('已切换到模拟金山文档')).toBeVisible();
  await page.getByRole('button', { name: '一键连接' }).click();
  for (const step of ['保存链接与令牌', '测试连接', '写入表格版式', '启用读取']) {
    await expect(page.locator('.kd-steps li.ok', { hasText: step })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.locator('.chip', { hasText: '已启用 · 手动读取' })).toBeVisible();
  // 默认「每家单位一个文件」：每家单位有自己的模拟文件
  await expect(page.locator('.kd-steps li.ok', { hasText: '16 家单位文件都能打开' })).toBeVisible();
  const mockHref = await page.locator('.kd-mock-links').getByRole('link', { name: '浦东', exact: true }).getAttribute('href');
  const fileId = new URL(mockHref!, baseURL).searchParams.get('file')!;
  expect(fileId).toMatch(/-PD$/);

  // 现场工作人员在「现场控制」页面操作，页面顶部有「读取金山表格」
  await page.goto(`/admin/events/${eventId}/control`);
  const readBtn = page.locator('.kd-read').getByRole('button', { name: '读取金山表格' });
  await expect(readBtn).toBeVisible();
  const readOnce = async () => {
    await readBtn.click();
    await expect(readBtn).toBeEnabled({ timeout: 15_000 });
  };

  // 大屏
  const key = await (await req.post(`/api/v1/admin/events/${eventId}/screen-keys`, { headers: H, data: { label: '主屏' } })).json();
  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screen = await screenCtx.newPage();
  await screen.goto((key.screenUrl as string).replace(/^https?:\/\/[^/]+/, baseURL!).replace('/screen#', '/screen/live#'));
  const pdCurrent = screen.locator('.s-row', { hasText: '浦东' }).locator('.s-current');
  await expect(pdCurrent).toContainText('30');

  // 浦东领导：手机打开本单位文件
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const sheet = await phone.newPage();
  await sheet.goto(`/mock-kdocs?file=${fileId}`);
  // 浦东的文件里只有浦东一张表，看不到其他单位
  await expect(sheet.locator('.mk-tab')).toHaveCount(1);
  const row = (r: number) => sheet.locator('.mk-grid tbody tr').nth(r - 1);
  await expect(row(2)).toContainText('理财 · 本组竞标中，可以加码', { timeout: 10_000 });
  await expect(row(3)).toContainText('首次填写即确认');
  const input = sheet.getByLabel('浦东 我要加到');
  await input.fill('35');
  await input.press('Enter');
  // 不点读取就不会处理
  await sheet.waitForTimeout(1500);
  await expect(row(7)).not.toContainText('已生效');

  const t0 = Date.now();
  await readOnce();
  await expect(pdCurrent).toContainText('35', { timeout: 10_000 });
  console.log(`点「读取金山表格」→ 大屏显示 35% 用时 ${Date.now() - t0} ms`);
  await expect(page.locator('.kd-read')).toContainText('新生效 1 条、认领底标 1 家（浦东）');
  await expect(row(7)).toContainText('✔ 理财已生效：30% → 35%', { timeout: 10_000 });
  await expect(input).toHaveValue('');
  await expect(row(4)).toContainText('35%');
  await expect(row(3)).toContainText('（已确认）');
  await sheet.screenshot({ path: `${SHOTS}/kdocs-mock-sheet.png` });

  // 填低了：不生效，写明原因
  await input.fill('30');
  await input.press('Enter');
  await readOnce();
  await expect(page.locator('.kd-read')).toContainText('未生效 1 条（浦东）');
  await expect(row(7)).toContainText('✘ 「30」未生效', { timeout: 10_000 });
  await expect(pdCurrent).toContainText('35');

  // 现场控制中来源标注「金山文档」；金山文档页看到处理记录
  await expect(page.locator('.chip', { hasText: '金山文档' }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/kdocs-control.png` });
  await page.goto(`/admin/events/${eventId}/kdocs`);
  await expect(page.getByText('已生效 1 · 未生效 1')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/kdocs-admin.png`, fullPage: true });

  // 领导扫码填报卡：每家一张，二维码即本单位文件
  await page.getByRole('button', { name: '生成扫码填报卡' }).click();
  const modal = page.locator('.modal-body');
  await expect(modal.locator('.leader-card')).toHaveCount(16);
  await expect(modal.locator('.leader-card').first()).toContainText('黄色「我要加到」格子');
  await modal.locator('.leader-card').first().screenshot({ path: `${SHOTS}/kdocs-card.png` });

  await Promise.all([admin.close(), screenCtx.close(), phone.close()]);
});
