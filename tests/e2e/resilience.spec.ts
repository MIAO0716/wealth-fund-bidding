/**
 * 断线与降级：大屏断网 20 秒后恢复（A21）、会话撤销后旧手机提示失效、SSE 被拦截时降级为 2 秒拉取、管理端导出下载。
 */
import { type APIRequestContext, type BrowserContext, expect, test } from '@playwright/test';

const H = { 'x-bidding-client': '1' };
const UNITS: Array<[string, number]> = [
  ['PD', 1], ['MH', 1], ['BS', 1], ['JD', 1], ['FX', 1], ['SJ', 1],
  ['HP', 2], ['HK', 2], ['JA', 2], ['PT', 2], ['CN', 2],
  ['XH', 3], ['YP', 3], ['QP', 3], ['JS', 3], ['CM', 3],
];
const MIN: Record<number, number> = { 1: 10, 2: 10, 3: 10 };

async function adminLogin(ctx: BrowserContext) {
  const r = await ctx.request.post('/api/v1/auth/admin/login', { headers: H, data: { username: 'admin', password: 'e2e-password-123' } });
  expect(r.ok()).toBe(true);
}

/** 准备：理财已发布并开始，第一组开放，浦东已认领底标；返回浦东会话的请求上下文 */
async function prepare(req: APIRequestContext, phoneReq: APIRequestContext, baseURL: string) {
  const ev = await (
    await req.post('/api/v1/admin/events', {
      headers: H,
      data: { config: { name: '断线测试', eventDate: '2099-12-31', metricName: 'm', amountBasis: '销量', statPeriod: 'p', dataSource: 'E2E' } },
    })
  ).json();
  const eventId: string = ev.event.id;
  const rows = UNITS.map(([u, g]) => ({ projectCode: 'wealth', unitCode: u, baseTargetWan: '100', firstRoundIncreasePp: MIN[g] }));
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
  const cred = await (await req.post(`/api/v1/admin/events/${eventId}/units/PD/credentials`, { headers: H, data: {} })).json();
  const token = new URL(cred.joinUrl).hash.replace('#t=', '');
  expect((await phoneReq.post('/api/v1/auth/bidder/exchange', { headers: H, data: { token } })).ok()).toBe(true);
  await phoneReq.post(`/api/v1/bidder/events/${eventId}/projects/wealth/base-ack`, { headers: H, data: { idempotencyKey: `ack-${eventId}` } });
  const key = await (await req.post(`/api/v1/admin/events/${eventId}/screen-keys`, { headers: H, data: { label: '测试屏' } })).json();
  const screenUrl = (key.screenUrl as string).replace(/^https?:\/\/[^/]+/, baseURL).replace('/screen#', '/screen/live#');
  let version = 0;
  const bidTo = async (pp: number) => {
    const r = await phoneReq.post(`/api/v1/bidder/events/${eventId}/projects/wealth/bids`, {
      headers: H,
      data: { targetIncreasePp: pp, expectedBidVersion: version, idempotencyKey: `bid-${eventId}-${pp}` },
    });
    expect(r.status()).toBe(201);
    version++;
  };
  return { eventId, screenUrl, bidTo };
}

test.setTimeout(150_000);

test('A21 大屏断网 20 秒后恢复：显示断线并保留数据，恢复后补齐，不重复叠加', async ({ browser, baseURL }) => {
  const admin = await browser.newContext();
  await adminLogin(admin);
  const phone = await browser.newContext();
  const { screenUrl, bidTo } = await prepare(admin.request, phone.request, baseURL!);

  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screen = await screenCtx.newPage();
  await screen.goto(screenUrl);
  const pdCurrent = screen.locator('.s-prow', { hasText: '浦东' }).locator('.s-current');
  await expect(pdCurrent).toContainText('10');
  await expect(screen.getByText('实时同步')).toBeVisible();
  await bidTo(15);
  await expect(pdCurrent).toContainText('15');

  await screenCtx.setOffline(true);
  // 断线期间的加码
  await bidTo(20);
  await bidTo(25);
  // 断网 20 秒：明确显示断线，保留最后一次已确认数据，不虚构断线期间的结果
  await expect(screen.getByText('连接中断，数据可能延迟').first()).toBeVisible({ timeout: 35_000 });
  await screen.waitForTimeout(20_000);
  await expect(pdCurrent).toContainText('15');
  await expect(screen.getByText('连接中断，数据可能延迟').first()).toBeVisible();

  await screenCtx.setOffline(false);
  await expect(pdCurrent).toContainText('25', { timeout: 20_000 });
  await expect(screen.getByText('实时同步')).toBeVisible({ timeout: 20_000 });
  // 首轮值不变；最新加码记录不重复
  await expect(screen.locator('.s-prow', { hasText: '浦东' }).locator('.s-first')).toContainText('10');
  const feed = await screen.locator('.s-feed-item').allTextContents();
  expect(feed.filter((t) => t.includes('20% → 25%'))).toHaveLength(1);
  await Promise.all([admin.close(), phone.close(), screenCtx.close()]);
});

test('工作人员撤销该单位访问后，旧手机无需刷新即提示会话失效，且不再自动重连', async ({ browser, baseURL }) => {
  const admin = await browser.newContext();
  await adminLogin(admin);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { eventId } = await prepare(admin.request, phone.request, baseURL!);
  const page = await phone.newPage();
  let streamRequests = 0;
  page.on('request', (r) => {
    if (r.url().includes('/stream')) streamRequests++;
  });
  await page.goto('/bid');
  await expect(page.getByText('实时同步')).toBeVisible({ timeout: 10_000 });
  await admin.request.post(`/api/v1/admin/events/${eventId}/units/PD/revoke`, { headers: H, data: {} });
  await expect(page.getByText(/本机未登录或已下线/)).toBeVisible({ timeout: 8_000 });
  const after = streamRequests;
  await page.waitForTimeout(5_000);
  expect(streamRequests).toBe(after);
  await Promise.all([admin.close(), phone.close()]);
});

test('SSE 被拦截时降级为 2 秒拉取，数据仍然更新', async ({ browser, baseURL }) => {
  const admin = await browser.newContext();
  await adminLogin(admin);
  const phone = await browser.newContext();
  const { screenUrl, bidTo } = await prepare(admin.request, phone.request, baseURL!);
  const screenCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await screenCtx.route('**/stream**', (r) => r.abort());
  const screen = await screenCtx.newPage();
  await screen.goto(screenUrl);
  await expect(screen.getByText('降级刷新（每 2 秒）')).toBeVisible({ timeout: 20_000 });
  await bidTo(15);
  await expect(screen.locator('.s-prow', { hasText: '浦东' }).locator('.s-current')).toContainText('15', { timeout: 5_000 });
  await Promise.all([admin.close(), phone.close(), screenCtx.close()]);
});

test('管理端导出：未锁定时文件名标注过程数据', async ({ browser, baseURL }) => {
  const admin = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await adminLogin(admin);
  const phone = await browser.newContext();
  const { eventId } = await prepare(admin.request, phone.request, baseURL!);
  const page = await admin.newPage();
  await page.goto(`/admin/events/${eventId}/export`);
  await expect(page.getByText('仍有项目未锁定')).toBeVisible();
  const respP = page.waitForResponse((r) => r.url().includes('/exports/ledger.xlsx'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '导出 Excel（四个工作表）' }).click()]);
  const resp = await respP;
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-disposition']).toContain(encodeURIComponent('（过程数据）'));
  expect(await dl.failure()).toBeNull();
  // 解析下载的文件：四个工作表，标题行标注过程数据
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await dl.path());
  expect(wb.worksheets.map((w) => w.name)).toEqual(['首轮结果', '最终竞标台账', '加码流水', '确认与控制记录']);
  expect(String(wb.getWorksheet('最终竞标台账')!.getRow(1).getCell(1).value)).toContain('过程数据');
  await Promise.all([admin.close(), phone.close()]);
});
