/**
 * 真实多浏览器会话的全流程 UI 测试：
 * 管理端（1440×900）、大屏（1920×1080）、浦东/闵行/黄浦三部手机（390×844），各自独立的浏览器上下文与 Cookie。
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';

// 截图保存到仓库 docs/screenshots（与运行目录无关）
const SHOTS = fileURLToPath(new URL('../../docs/screenshots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const CONFIG = {
  name: '2026年理财、基金现场竞标（E2E）',
  year: 2026,
  eventDate: '2099-12-31',
};

const UNITS: Array<[string, number]> = [
  ['PD', 1], ['MH', 1], ['BS', 1], ['JD', 1], ['FX', 1], ['SJ', 1],
  ['HP', 2], ['HK', 2], ['JA', 2], ['PT', 2], ['CN', 2],
  ['XH', 3], ['YP', 3], ['QP', 3], ['JS', 3], ['CM', 3],
];
const MIN: Record<number, number> = { 1: 10, 2: 10, 3: 10 };

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
  await admin.getByRole('button', { name: '16 家领导使用卡（生成 / 打印）' }).click();
  await expect(admin.locator('.modal .leader-card')).toHaveCount(16);
  // 每页一个单位：上半部分为会前首轮数据，下半部分为二维码与使用说明
  const pdCard = admin.locator('.modal .leader-card').first();
  await expect(pdCard).toContainText('浦东');
  await expect(pdCard).toContainText('会前首轮数据');
  await expect(pdCard.locator('.lp-tile', { hasText: '理财' })).toContainText('100.00');
  await expect(pdCard.locator('.lp-tile', { hasText: '理财' })).toContainText('30%');
  await expect(pdCard.locator('.lp-tile', { hasText: '基金' })).toContainText('250.50');
  await expect(pdCard).toContainText('用手机自带「相机」扫左侧二维码');
  await expect(admin.locator('.modal .leader-card').first()).toContainText('Meeting-5G');
  await admin.locator('.modal .leader-card').first().screenshot({ path: `${SHOTS}/leader-card.png` });
  // 打印版式（A4 每页一个单位）
  await admin.pdf({ path: `${SHOTS}/leader-card-print.pdf`, format: 'A4', printBackground: true });
  // 二维码活动期间固定不变：再次打开是同一个二维码
  const firstCard = await admin.locator('.modal .leader-card').first().innerHTML();
  await admin.getByRole('button', { name: '关闭', exact: true }).click();
  await admin.getByRole('button', { name: '16 家领导使用卡（生成 / 打印）' }).click();
  await expect(admin.locator('.modal .leader-card')).toHaveCount(16);
  expect(await admin.locator('.modal .leader-card').first().innerHTML()).toBe(firstCard);
  await admin.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(admin.getByRole('button', { name: '作废' })).toHaveCount(0);

  // 大屏链接与二维码
  const key = await (await req.post(`/api/v1/admin/events/${eventId}/screen-keys`, { headers: H, data: { label: '主屏' } })).json();
  const issue = async (u: string) => (await (await req.post(`/api/v1/admin/events/${eventId}/units/${u}/credentials`, { headers: H, data: {} })).json()).joinUrl as string;

  // ---------------------------------------------------------- 大屏（跟随模式）
  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screen = await screenCtx.newPage();
  await screen.goto(key.screenUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(screen.locator('.s-center-msg')).toContainText('首轮结果待发布');
  expect(screen.url()).not.toContain('#k=');

  // ---------------------------------------------------------- 手机：浦东、闵行、黄浦
  const pd = await phone(browser, (await issue('PD')).replace(/^https?:\/\/[^/]+/, baseURL!));
  const mh = await phone(browser, (await issue('MH')).replace(/^https?:\/\/[^/]+/, baseURL!));
  const hp = await phone(browser, (await issue('HP')).replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(pd.page.getByText('首轮结果待发布')).toBeVisible();
  await expect(pd.page.locator('.m-unit')).toContainText('浦东');
  // 首次进入显示三步说明，可关闭
  await expect(pd.page.getByText('使用说明（三步）')).toBeVisible();
  await shot(pd.page, 'phone-first-visit');
  await pd.page.getByRole('button', { name: '知道了' }).click();
  await expect(pd.page.getByText('使用说明（三步）')).toHaveCount(0);

  // ---------------------------------------------------------- 会前准备：理财、基金首轮一起冻结（界面操作）
  await admin.goto(`/admin/events/${eventId}/first-round`);
  await expect(admin.getByText('理财：已录入 16/16')).toBeVisible();
  await expect(admin.getByText('基金：已录入 16/16')).toBeVisible();
  await admin.getByRole('button', { name: '一起冻结理财、基金首轮' }).click();
  await admin.getByRole('button', { name: '确认冻结' }).click();
  await expect(admin.getByText(/已冻结：理财（LC-R1-.*）、基金（JJ-R1-.*）/)).toBeVisible();
  await expect(admin.getByText('理财、基金首轮均已冻结')).toBeVisible();

  // 大屏自动切到首轮：三组 16 家
  await expect(screen.getByText('会前首轮结果', { exact: false })).toBeVisible();
  await expect(screen.locator('.s-row')).toHaveCount(16);
  // 首轮大屏只保留「理财 · 会前首轮结果」，不显示发布时间、录入数和下方说明
  await expect(screen.getByText('家已录入')).toHaveCount(0);
  await expect(screen.getByText('首轮为会前上报数据', { exact: false })).toHaveCount(0);
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
  // 现场控制显示网络延迟
  await expect(admin.getByText(/网络延迟 \d+ ms/)).toBeVisible();

  // 大屏自动切到实时榜：只展示进行中的第一组（6 家），带目标金额
  await expect(screen.locator('.s-panel.open')).toHaveCount(1);
  await expect(screen.locator('.s-prow')).toHaveCount(6);
  await expect(screen.locator('.s-step.on')).toContainText('第一组');

  // 黄浦（第二组）未轮到：按钮禁用并说明原因
  await expect(hp.page.getByText('尚未轮到本组，请等待')).toBeVisible();
  await expect(hp.page.locator('.m-main-btn')).toBeDisabled();

  // ---------------------------------------------------------- 浦东 30% 追加 +5（快捷按钮）
  await expect(pd.page.locator('.m-current')).toContainText('30');
  await pd.page.getByRole('button', { name: /^\+5\s*个百分点/ }).click();
  await expect(pd.page.locator('.m-main-btn')).toHaveText('确认追加 +5 个百分点');
  await pd.page.locator('.m-main-btn').click();
  const modal = pd.page.locator('.modal');
  await expect(modal.locator('.m-confirm-row')).toContainText('30%');
  await expect(modal.locator('.m-confirm-row')).toContainText('35%');
  await expect(modal).toContainText('135 万元');
  await expect(modal).toContainText('确认后不可自行下调');
  await shot(pd.page, 'phone-confirm');
  const t0 = Date.now();
  await modal.getByRole('button', { name: '确认提交' }).click();
  await expect(pd.page.getByRole('heading', { name: '追加成功 · 服务器已确认' })).toBeVisible();
  await expect(pd.page.locator('.m-current')).toContainText('35');

  // 大屏 PD 行更新为 35%
  const pdRow = screen.locator('.s-prow', { hasText: '浦东' });
  await expect(pdRow.locator('.s-current')).toContainText('35');
  // 目标金额随增幅实时计算：100 万 × 1.35
  await expect(pdRow.locator('.s-target')).toHaveText('135');
  // 专场字样居中显示；右上角显示领导在线数
  await expect(screen.locator('.s-head-center')).toHaveText('理财专场');
  await expect(screen.locator('.s-online')).toContainText(/领导在线 \d+\/16/);
  const latency = Date.now() - t0;
  console.log(`浦东点击确认 → 大屏显示 35% 用时 ${latency} ms`);
  expect(latency).toBeLessThan(3000);
  await expect(screen.locator('.s-feed-item').first()).toContainText('浦东 30% → 35%');
  await expect(screen.getByText('标王候选：浦东')).toBeVisible();
  await shot(pd.page, 'phone-bid');

  // 闵行 10% → 选 +10，再「＋」两次 → +12 → 22%（每次加码为 1 的整数倍）
  await mh.page.getByRole('button', { name: /^\+10\s*个百分点/ }).click();
  await mh.page.getByRole('button', { name: '增加 1 个百分点' }).click();
  await mh.page.getByRole('button', { name: '增加 1 个百分点' }).click();
  await expect(mh.page.getByLabel('追加百分点')).toHaveValue('12');
  await expect(mh.page.locator('.m-preview')).toContainText('22%');
  await mh.page.locator('.m-main-btn').click();
  await mh.page.locator('.modal').getByRole('button', { name: '确认提交' }).click();
  await expect(mh.page.getByRole('heading', { name: '追加成功 · 服务器已确认' })).toBeVisible();
  await expect(screen.locator('.s-prow', { hasText: '闵行' }).locator('.s-current')).toContainText('22');
  await shot(screen, 'screen-live');
  await shot(admin, 'admin-control');

  // 闵行误操作：工作人员「代录 → 下调更正」改回 15%，只需弹窗确认，不填原因
  await admin.locator('.board-group.open tr', { hasText: '闵行' }).getByRole('button', { name: '代录' }).click();
  await admin.getByRole('button', { name: '下调更正（误操作）' }).click();
  await admin.getByLabel('更正后的增幅').fill('15');
  await expect(admin.locator('.modal')).toContainText('115 万元');
  await admin.getByRole('button', { name: '确认下调为 15%' }).click();
  await expect(admin.getByText(/已更正 闵行 22% → 15%/)).toBeVisible();
  await expect(screen.locator('.s-prow', { hasText: '闵行' }).locator('.s-current')).toContainText('15');
  await expect(mh.page.locator('.m-current')).toContainText('15');
  await expect(mh.page.getByText('（工作人员更正）')).toBeVisible();

  // 无横向溢出、16 家完整可见
  const phoneOverflow = await pd.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(phoneOverflow).toBeLessThanOrEqual(0);
  const outside = await screen.locator('.s-prow').evaluateAll((els) =>
    els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > window.innerHeight || r.right > window.innerWidth || r.top < 0;
    }).length,
  );
  expect(outside).toBe(0);

  // ---------------------------------------------------------- 结束三组 → 自动暂停 → 锁定理财
  await admin.getByRole('button', { name: '结束本组' }).click();
  await expect(pd.page.getByText('本组竞标已结束')).toBeVisible();
  // 本组结束：大屏停留在第一组最终结果，直到下一组开始
  await expect(screen.locator('.s-panel-state')).toHaveText('本组竞标结束 · 最终结果');
  await expect(screen.locator('.s-prow.top')).toContainText('浦东');
  await expect(screen.getByText('本组标王：浦东')).toBeVisible();
  await screen.waitForTimeout(1000); // 等入场动画结束再截图
  await shot(screen, 'screen-group-final');
  for (let g = 0; g < 2; g++) {
    await admin.getByRole('button', { name: '开放本组' }).first().click();
    await expect(admin.getByRole('button', { name: '结束本组' })).toBeVisible();
    // 下一组开始：大屏平滑切换到该组
    await expect(screen.locator('.s-step.on')).toContainText(g === 0 ? '第二组' : '第三组');
    await expect(screen.locator('.s-panel')).toHaveCount(1);
    await expect(screen.locator('.s-prow')).toHaveCount(5);
    await admin.getByRole('button', { name: '结束本组' }).click();
    await expect(admin.getByRole('button', { name: '结束本组' })).toHaveCount(0);
  }
  await expect(admin.locator('.chip', { hasText: '已暂停' })).toBeVisible();
  await admin.getByRole('button', { name: '锁定项目…' }).click();
  await admin.getByLabel('已与现场核对三组结果，确认锁定').check();
  await admin.getByRole('button', { name: '确认锁定' }).click();
  await expect(admin.locator('.chip', { hasText: '已锁定' })).toBeVisible();
  // 理财锁定后手机自动转到基金专场
  await expect(pd.page.locator('.m-tag.gold')).toHaveText('基金专场');

  // 结果大屏
  await admin.getByRole('button', { name: '最终结果' }).click();
  await expect(screen.locator('.s-result-project').first()).toContainText('现场标王');
  // 最终结果显示首轮到最终的加码：浦东 30% → 35%（+5）
  await expect(screen.locator('.s-result-row.top', { hasText: '浦东' }).locator('.added')).toHaveText('+5');
  await expect(screen.locator('.s-result-row.top', { hasText: '浦东' })).toContainText('35%');
  await screen.waitForTimeout(1000); // 等入场动画结束再截图
  // 每个项目下方显示全市合计：底标 16×100 万 = 0.16 亿 → 目标 1,790 万 = 0.18 亿，增幅 11.88%
  const total = screen.locator('.s-result-project').first().locator('.s-total');
  await expect(total).toContainText('0.16');
  await expect(total).toContainText('0.18');
  await expect(total).toContainText('11.88%');
  await shot(screen, 'screen-results');

  // ---------------------------------------------------------- 基金：首轮已在会前冻结，理财锁定后手机自动转到基金
  await expect(pd.page.locator('.m-tag.gold')).toHaveText('基金专场');
  await expect(pd.page.getByRole('button', { name: '确认认领基础底标' })).toBeVisible();
  await admin.goto(`/admin/events/${eventId}/control`);
  await admin.getByRole('button', { name: '基金', exact: true }).click();
  await admin.getByRole('button', { name: '首轮结果' }).click();
  await expect(screen.getByText('基金 · 会前首轮结果')).toBeVisible();
  await admin.getByRole('button', { name: '开放本组' }).first().click();
  await expect(admin.getByText('第1组竞标中')).toBeVisible();
  await expect(screen.locator('.s-panel.open .s-prow')).toHaveCount(6);
  await admin.goto(`/admin/events/${eventId}/first-round`);
  await shot(admin, 'admin-first-round');

  for (const ctx of [adminCtx, screenCtx, pd.ctx, mh.ctx, hp.ctx]) await ctx.close();
});

test('换手机：同一二维码在第二部手机上扫码直接登录，第一部手机自动下线', async ({ browser }) => {
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
  await expect(p1.locator('.m-unit')).toContainText('闵行');
  // 另一部手机扫同一个码：直接登录；第一部手机无需刷新即提示已下线
  const second = await browser.newContext(PHONE);
  const p2 = await second.newPage();
  await p2.goto(url);
  await p2.waitForURL('**/bid');
  await expect(p2.locator('.m-unit')).toContainText('闵行');
  await expect(p1.getByText(/本机未登录或已下线/)).toBeVisible({ timeout: 8_000 });
  // 工作人员「强制下线」：第二部手机下线，二维码仍可再扫
  expect((await req.post(`/api/v1/admin/events/${ev.event.id}/units/MH/kick`, { headers: H, data: {} })).ok()).toBe(true);
  await expect(p2.getByText(/本机未登录或已下线/)).toBeVisible({ timeout: 8_000 });
  await p2.goto(url);
  await p2.waitForURL('**/bid');
  await expect(p2.locator('.m-unit')).toContainText('闵行');
  await Promise.all([adminCtx.close(), first.close(), second.close()]);
});

test('会话失效与非法入口有明确提示', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/join#t=invalid-token-aaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByText('无法进入')).toBeVisible();
  await page.goto('/bid');
  await expect(page.getByText(/本机未登录或已下线/)).toBeVisible();
  const s = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const sp = await s.newPage();
  await sp.goto('/screen/live');
  await expect(sp.getByText('请使用管理端生成的大屏链接打开本页面')).toBeVisible();
  await ctx.close();
  await s.close();
});

test('活动列表删除活动：弹窗确认后连同数据一并删除', async ({ browser }) => {
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const req = adminCtx.request;
  expect((await req.post('/api/v1/auth/admin/login', { headers: H, data: { username: 'admin', password: 'e2e-password-123' } })).ok()).toBe(true);
  const ev = await (await req.post('/api/v1/admin/events', { headers: H, data: { config: { name: '待删除的测试活动', eventDate: '2099-12-31' } } })).json();
  const page = await adminCtx.newPage();
  await page.goto('/admin');
  const row = page.locator('tr', { hasText: '待删除的测试活动' });
  await row.getByRole('button', { name: '删除' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('删除后不可恢复');
  await expect(modal.getByRole('button', { name: '确认删除' })).toBeDisabled();
  await modal.getByLabel('我确认删除「待删除的测试活动」及其全部数据').check();
  await modal.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('已删除活动「待删除的测试活动」及其全部数据')).toBeVisible();
  await expect(page.locator('tr', { hasText: '待删除的测试活动' })).toHaveCount(0);
  expect((await req.get(`/api/v1/admin/events/${ev.event.id}/state`, { headers: H })).status()).toBe(404);
  await adminCtx.close();
});
