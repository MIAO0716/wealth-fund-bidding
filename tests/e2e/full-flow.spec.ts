/**
 * 真实多浏览器会话的全流程 UI 测试：
 * 管理端（1440×900）、大屏（1920×1080）、浦东/闵行/黄浦三部手机（390×844），各自独立的浏览器上下文与 Cookie。
 */
import { mkdirSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';

const SHOTS = 'docs/screenshots';
mkdirSync(`../../${SHOTS}`, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `../../${SHOTS}/${name}.png` });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const CONFIG = {
  name: '2026年理财、基金现场竞标（E2E）',
  year: 2026,
  eventDate: '2099-12-31',
  metricName: '测试指标',
  amountBasis: '销量',
  statPeriod: '活动期',
  dataSource: 'E2E 测试数据，非正式数据',
};

const UNITS: Array<[string, number]> = [
  ['PD', 1], ['MH', 1], ['BS', 1], ['JD', 1], ['FX', 1], ['SJ', 1],
  ['HP', 2], ['HK', 2], ['JA', 2], ['PT', 2], ['CN', 2],
  ['XH', 3], ['YP', 3], ['QP', 3], ['JS', 3], ['CM', 3],
];
const MIN: Record<number, number> = { 1: 5, 2: 10, 3: 15 };

function rows(project: 'wealth' | 'fund') {
  return UNITS.map(([code, g]) => ({
    projectCode: project,
    unitCode: code,
    baseTargetWan: project === 'wealth' ? '100.00' : '250.50',
    firstRoundIncreasePp: code === 'PD' && project === 'wealth' ? 30 : MIN[g],
  }));
}

const H = { 'x-bidding-client': '1' };

async function phone(browser: Browser, joinUrl: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(joinUrl);
  await page.waitForURL('**/bid');
  // 凭证已从地址栏移除
  expect(page.url()).not.toContain('#t=');
  return { ctx, page };
}

test('双项目完整流程：导入 → 发布首轮 → 认领 → 分组加码 → 锁定 → 基金', async ({ browser, baseURL }) => {
  // ---------------------------------------------------------- 管理端登录
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admin = await adminCtx.newPage();
  await admin.goto('/admin');
  await admin.getByLabel('账号').fill('admin');
  await admin.getByLabel('密码').fill('e2e-password-123');
  await admin.getByRole('button', { name: '登录' }).click();
  await expect(admin.getByText('新建活动')).toBeVisible();

  // 通过接口准备活动与首轮数据（与界面共用登录 Cookie）
  const req = adminCtx.request;
  const ev = await (await req.post('/api/v1/admin/events', { headers: H, data: { config: CONFIG } })).json();
  const eventId: string = ev.event.id;
  const v = await (await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/validate`, { headers: H, data: { mode: 'upsert', rows: [...rows('wealth'), ...rows('fund')] } })).json();
  expect(v.valid).toBe(true);
  const c = await req.post(`/api/v1/admin/events/${eventId}/first-round/imports/commit`, {
    headers: H,
    data: { validationId: v.validationId, expectedDraftVersion: v.draftVersion, idempotencyKey: 'e2e-import-0001' },
  });
  expect(c.ok()).toBe(true);

  // 领导使用卡：配置会场 Wi-Fi 后批量生成，卡上印 Wi-Fi 二维码、单位二维码与三步说明
  await req.patch(`/api/v1/admin/events/${eventId}/config`, { headers: H, data: { wifiSsid: 'Meeting-5G', wifiPassword: '12345678' } });
  await admin.goto(`/admin/events/${eventId}/access`);
  admin.once('dialog', (d) => void d.accept());
  await admin.getByRole('button', { name: '批量生成 16 家领导使用卡（打印）' }).click();
  await expect(admin.locator('.modal .leader-card')).toHaveCount(16);
  await expect(admin.locator('.modal .leader-card').first()).toContainText('打开微信「扫一扫」');
  await expect(admin.locator('.modal .leader-card').first()).toContainText('Meeting-5G');
  await admin.locator('.modal .leader-card').first().screenshot({ path: `../../${SHOTS}/leader-card.png` });
  await admin.getByRole('button', { name: '关闭（二维码不再显示）' }).click();

  // 大屏链接与二维码
  const key = await (await req.post(`/api/v1/admin/events/${eventId}/screen-keys`, { headers: H, data: { label: '主屏' } })).json();
  const issue = async (u: string) => (await (await req.post(`/api/v1/admin/events/${eventId}/units/${u}/credentials`, { headers: H, data: {} })).json()).joinUrl as string;

  // ---------------------------------------------------------- 大屏（跟随模式）
  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screen = await screenCtx.newPage();
  await screen.goto(key.screenUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(screen.getByText('首轮结果待现场发布')).toBeVisible();
  expect(screen.url()).not.toContain('#k=');

  // ---------------------------------------------------------- 手机：浦东、闵行、黄浦
  const pd = await phone(browser, (await issue('PD')).replace(/^https?:\/\/[^/]+/, baseURL!));
  const mh = await phone(browser, (await issue('MH')).replace(/^https?:\/\/[^/]+/, baseURL!));
  const hp = await phone(browser, (await issue('HP')).replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(pd.page.getByText('首轮结果待现场发布')).toBeVisible();
  await expect(pd.page.locator('.m-unit')).toContainText('浦东');
  // 首次进入显示三步说明，可关闭
  await expect(pd.page.getByText('使用说明（三步）')).toBeVisible();
  await shot(pd.page, 'phone-first-visit');
  await pd.page.getByRole('button', { name: '知道了' }).click();
  await expect(pd.page.getByText('使用说明（三步）')).toHaveCount(0);

  // ---------------------------------------------------------- 管理端发布理财首轮（界面操作）
  await admin.goto(`/admin/events/${eventId}/first-round`);
  await expect(admin.getByText('完整性 16/16')).toBeVisible();
  await admin.getByRole('button', { name: '发布首轮并冻结' }).click();
  await admin.getByLabel('我已核对 16 家底标与首轮数据，确认发布').check();
  await admin.getByRole('button', { name: '确认发布' }).click();
  await expect(admin.getByText(/首轮已发布并冻结/)).toBeVisible();

  // 大屏自动切到首轮：三组 16 家
  await expect(screen.getByText('会前首轮结果', { exact: false })).toBeVisible();
  await expect(screen.locator('.s-row')).toHaveCount(16);
  await expect(screen.getByText('16/16家已录入')).toBeVisible();
  await shot(screen, 'screen-first-round');

  // ---------------------------------------------------------- 领导认领底标
  for (const p of [pd, mh, hp]) {
    await p.page.getByRole('button', { name: '确认认领基础底标' }).click();
    await p.page.getByRole('button', { name: '确认认领', exact: true }).click();
    await expect(p.page.getByText(/已确认认领底标/)).toBeVisible();
  }

  // ---------------------------------------------------------- 开始竞标并开放第一组
  await admin.goto(`/admin/events/${eventId}/control`);
  // 首轮已发布、未开始：提示下一步，并可直接「开放本组」（自动开始竞标）
  await expect(admin.getByText('下一步：点下方第一组的「开放本组」')).toBeVisible();
  await expect(admin.getByRole('button', { name: '代录' }).first()).toBeDisabled();
  await admin.getByRole('button', { name: '开放本组' }).first().click();
  await expect(admin.locator('.chip', { hasText: '竞标中' })).toBeVisible();
  await expect(admin.locator('.board-group.open').first()).toBeVisible();
  await expect(admin.getByText('第1组竞标中')).toBeVisible();

  // 大屏自动切到实时榜
  await expect(screen.locator('.s-group.open')).toHaveCount(1);
  await expect(screen.locator('.s-row')).toHaveCount(16);

  // 黄浦（第二组）未轮到：按钮禁用并说明原因
  await expect(hp.page.getByText('尚未轮到本组，请等待')).toBeVisible();
  await expect(hp.page.locator('.m-main-btn')).toBeDisabled();

  // ---------------------------------------------------------- 浦东 30% 追加 +5
  await expect(pd.page.locator('.m-current')).toContainText('30');
  await expect(pd.page.locator('.m-main-btn')).toHaveText('追加5个百分点');
  await pd.page.locator('.m-main-btn').click();
  const modal = pd.page.locator('.modal');
  await expect(modal.locator('.m-confirm-row')).toContainText('30%');
  await expect(modal.locator('.m-confirm-row')).toContainText('35%');
  await expect(modal).toContainText('135.00 万元');
  await expect(modal).toContainText('确认后不可下调');
  await shot(pd.page, 'phone-confirm');
  const t0 = Date.now();
  await modal.getByRole('button', { name: '确认提交' }).click();
  await expect(pd.page.getByRole('heading', { name: '追加成功 · 服务器已确认' })).toBeVisible();
  await expect(pd.page.locator('.m-current')).toContainText('35');

  // 大屏 PD 行更新为 35%
  const pdRow = screen.locator('.s-row', { hasText: '浦东' });
  await expect(pdRow.locator('.s-current')).toContainText('35');
  const latency = Date.now() - t0;
  console.log(`浦东点击确认 → 大屏显示 35% 用时 ${latency} ms`);
  expect(latency).toBeLessThan(3000);
  await expect(screen.locator('.s-feed-item').first()).toContainText('浦东 理财 30% → 35%');
  await expect(screen.getByText('标王候选：浦东')).toBeVisible();
  await shot(pd.page, 'phone-bid');

  // 闵行 5% → 选 +10 → 15%
  await mh.page.getByRole('button', { name: /\+10/ }).click();
  await expect(mh.page.locator('.m-preview')).toContainText('15%');
  await mh.page.locator('.m-main-btn').click();
  await mh.page.locator('.modal').getByRole('button', { name: '确认提交' }).click();
  await expect(mh.page.getByRole('heading', { name: '追加成功 · 服务器已确认' })).toBeVisible();
  await expect(screen.locator('.s-row', { hasText: '闵行' }).locator('.s-current')).toContainText('15');
  await shot(screen, 'screen-live');
  await shot(admin, 'admin-control');

  // 无横向溢出、16 家完整可见
  const phoneOverflow = await pd.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(phoneOverflow).toBeLessThanOrEqual(0);
  const outside = await screen.locator('.s-row').evaluateAll((els) =>
    els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > window.innerHeight || r.right > window.innerWidth || r.top < 0;
    }).length,
  );
  expect(outside).toBe(0);

  // ---------------------------------------------------------- 结束三组 → 自动暂停 → 锁定理财
  await admin.getByRole('button', { name: '结束本组' }).click();
  await expect(pd.page.getByText('本组竞标已结束')).toBeVisible();
  for (let g = 0; g < 2; g++) {
    await admin.getByRole('button', { name: '开放本组' }).first().click();
    await expect(admin.getByRole('button', { name: '结束本组' })).toBeVisible();
    await admin.getByRole('button', { name: '结束本组' }).click();
    await expect(admin.getByRole('button', { name: '结束本组' })).toHaveCount(0);
  }
  await expect(admin.locator('.chip', { hasText: '已暂停' })).toBeVisible();
  await admin.getByRole('button', { name: '锁定项目…' }).click();
  await admin.getByLabel('已与现场核对三组结果，确认锁定').check();
  await admin.getByRole('button', { name: '确认锁定' }).click();
  await expect(admin.locator('.chip', { hasText: '已锁定' })).toBeVisible();
  await expect(pd.page.locator('.m-tag', { hasText: '已结束' })).toBeVisible();

  // 结果大屏
  await admin.getByRole('button', { name: '最终结果' }).click();
  await expect(screen.locator('.s-result-project').first()).toContainText('现场标王');
  await expect(screen.locator('.s-result-row.top', { hasText: '浦东' })).toContainText('35%');
  await shot(screen, 'screen-results');

  // ---------------------------------------------------------- 基金：理财锁定后可发布
  await admin.goto(`/admin/events/${eventId}/first-round`);
  await admin.getByRole('button', { name: '基金首轮' }).click();
  await admin.getByRole('button', { name: '发布首轮并冻结' }).click();
  await admin.getByLabel('我已核对 16 家底标与首轮数据，确认发布').check();
  await admin.getByRole('button', { name: '确认发布' }).click();
  await expect(admin.getByText(/基金首轮已发布并冻结/)).toBeVisible();
  await expect(screen.getByText('基金 · 会前首轮结果')).toBeVisible();
  // 手机自动切到基金专场，可认领基金底标
  await expect(pd.page.locator('.m-tag.gold')).toHaveText('基金专场');
  await expect(pd.page.getByRole('button', { name: '确认认领基础底标' })).toBeVisible();
  await shot(admin, 'admin-first-round');

  for (const ctx of [adminCtx, screenCtx, pd.ctx, mh.ctx, hp.ctx]) await ctx.close();
});

test('同一二维码在第二部手机上扫码：提示单位与处理办法', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const req = adminCtx.request;
  expect((await req.post('/api/v1/auth/admin/login', { headers: H, data: { username: 'admin', password: 'e2e-password-123' } })).ok()).toBe(true);
  const ev = await (await req.post('/api/v1/admin/events', { headers: H, data: { config: CONFIG } })).json();
  const url = (await (await req.post(`/api/v1/admin/events/${ev.event.id}/units/MH/credentials`, { headers: H, data: {} })).json()).joinUrl as string;
  const first = await browser.newContext(PHONE);
  const p1 = await first.newPage();
  await p1.goto(url);
  await p1.waitForURL('**/bid');
  // 同一手机再次扫码：直接进入
  await p1.goto(url);
  await p1.waitForURL('**/bid');
  // 另一部手机扫同一个码：说明是哪家单位、怎么处理
  const second = await browser.newContext(PHONE);
  const p2 = await second.newPage();
  await p2.goto(url);
  await expect(p2.getByText('闵行的二维码已在一部手机上使用过')).toBeVisible();
  await expect(p2.getByText('换手机')).toBeVisible();
  await Promise.all([adminCtx.close(), first.close(), second.close()]);
});

test('会话失效与非法入口有明确提示', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/join#t=invalid-token-aaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByText('无法进入')).toBeVisible();
  await page.goto('/bid');
  await expect(page.getByText('会话失效，请联系工作人员重新扫码')).toBeVisible();
  const s = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const sp = await s.newPage();
  await sp.goto('/screen/live');
  await expect(sp.getByText('请使用管理端生成的大屏链接打开本页面')).toBeVisible();
  await ctx.close();
  await s.close();
});
