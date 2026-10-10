// 安装包冒烟测试：对已启动的打包服务做一次端到端检查。
//   node tests/package/smoke.mjs setup  → 新建演示活动、发布、开始、扫码、认领、加码、导出；记录活动 ID
//   node tests/package/smoke.mjs verify → 重启后检查数据仍在
// 环境变量：BASE_URL（默认 http://127.0.0.1:8080）、ADMIN_PASSWORD、STATE_FILE
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const STATE = process.env.STATE_FILE ?? 'smoke-state.json';
const mode = process.argv[2] ?? 'setup';
const H = { 'x-bidding-client': '1', 'content-type': 'application/json' };

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
async function req(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(method === 'GET' ? {} : H), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, res: r };
}

const page = await fetch(`${BASE}/admin`);
assert(page.status === 200 && (await page.text()).includes('<title>现场竞标</title>'), '管理端页面可访问');
const login = await req('POST', '/api/v1/auth/admin/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
assert(login.status === 200, '管理员登录');
const admin = cookieOf(login.res);

if (mode === 'setup') {
  const ev = (await req('POST', '/api/v1/admin/events', { isDemo: true }, admin)).data.event;
  const E = `/api/v1/admin/events/${ev.id}`;
  const fr = (await req('GET', `${E}/first-round`, undefined, admin)).data;
  const pub = await req('POST', `${E}/projects/wealth/publish-first-round`, { expectedDraftVersion: fr.projects.wealth.project.draftVersion, idempotencyKey: `smoke-pub-${ev.id}`, confirm: true }, admin);
  assert(pub.status === 200, '发布理财首轮');
  let st = (await req('GET', `${E}/state`, undefined, admin)).data;
  const start = await req('POST', `${E}/projects/wealth/control`, { action: 'START', groupNo: 1, expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `smoke-start-${ev.id}` }, admin);
  assert(start.status === 200, '开始竞标并开放第一组');
  const cred = (await req('POST', `${E}/units/PD/credentials`, {}, admin)).data;
  assert(/^https?:\/\/[^/]+\/join#t=/.test(cred.joinUrl), `二维码地址：${cred.joinUrl.replace(/#t=.*/, '#t=…')}`);
  const ex = await req('POST', '/api/v1/auth/bidder/exchange', { token: new URL(cred.joinUrl).hash.slice(3) });
  assert(ex.status === 200, '领导扫码换取会话');
  const pd = cookieOf(ex.res);
  const ack = await req('POST', `/api/v1/bidder/events/${ev.id}/projects/wealth/base-ack`, { idempotencyKey: `smoke-ack-${ev.id}` }, pd);
  assert(ack.status === 200, '确认认领底标');
  const me = (await req('GET', `/api/v1/bidder/events/${ev.id}/me`, undefined, pd)).data;
  const from = me.projects.wealth.currentPp;
  const bid = await req('POST', `/api/v1/bidder/events/${ev.id}/projects/wealth/bids`, { targetIncreasePp: from + 5, expectedBidVersion: 0, idempotencyKey: `smoke-bid-${ev.id}` }, pd);
  assert(bid.status === 201 && bid.data.receipt.toPp === from + 5, `追加 ${from}% → ${from + 5}%`);
  // 实时推送：大屏连接应立即收到 hello（经反向代理时验证未被缓冲）
  const key = (await req('POST', `${E}/screen-keys`, { label: '冒烟' }, admin)).data;
  const sx = await req('POST', '/api/v1/auth/screen/exchange', { key: new URL(key.screenUrl).hash.slice(3) });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  let hello = false;
  try {
    const stream = await fetch(`${BASE}/api/v1/screen/events/${ev.id}/stream?since=0`, { headers: { cookie: cookieOf(sx.res) }, signal: ac.signal });
    const reader = stream.body.getReader();
    let text = '';
    while (!hello) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      hello = text.includes('event: hello');
    }
  } catch {
    // 超时
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  assert(hello, '实时推送（SSE）连接 5 秒内收到 hello');
  const xlsx = await req('GET', `${E}/exports/ledger.xlsx`, undefined, admin);
  assert(xlsx.status === 200 && xlsx.data.byteLength > 5000, 'Excel 导出');
  st = (await req('GET', `${E}/state`, undefined, admin)).data;
  const pause = await req('POST', `${E}/projects/wealth/control`, { action: 'PAUSE', expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `smoke-pause-${ev.id}` }, admin);
  const lock = await req('POST', `${E}/projects/wealth/control`, { action: 'LOCK', confirm: true, expectedControlVersion: pause.data.controlVersion, idempotencyKey: `smoke-lock-${ev.id}` }, admin);
  assert(lock.status === 200, '锁定理财');
  // 自动检查点（pg_dump）
  let checkpoints = 0;
  for (let i = 0; i < 40 && checkpoints < 2; i++) {
    await new Promise((r) => setTimeout(r, 500));
    checkpoints = (await req('GET', '/api/v1/admin/maintenance', undefined, admin)).data.logs.filter((l) => l.action === 'CHECKPOINT').length;
  }
  assert(checkpoints >= 2, `自动检查点已生成 ${checkpoints} 个`);
  writeFileSync(STATE, JSON.stringify({ eventId: ev.id, toPp: from + 5 }));
} else {
  const { eventId, toPp } = JSON.parse(readFileSync(STATE, 'utf8'));
  const st = await req('GET', `/api/v1/admin/events/${eventId}/state`, undefined, admin);
  assert(st.status === 200, '重启后活动仍在');
  assert(st.data.projects.wealth.status === 'LOCKED', '锁定状态保留');
  const pdRow = st.data.boards.wealth[0].rows.find((r) => r.unitCode === 'PD');
  assert(pdRow.currentPp === toPp, `浦东增幅保留为 ${toPp}%`);
}
console.log('冒烟测试通过');
