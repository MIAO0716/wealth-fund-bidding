// 性能验证：16 个领导会话 + 2 块大屏 + 1 个管理端同时在线，测量「服务端确认时间 → 大屏收到推送」的延迟。
// 用法（服务需已启动；会新建一场演示活动，不影响正式活动）：
//   BASE_URL=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASSWORD=... node tests/perf/load.mjs
// 注意：延迟以本机时钟计算，压测脚本应与服务端在同一台机器或已校时的机器上运行。

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const H = { 'x-bidding-client': '1', 'content-type': 'application/json' };

function cookieOf(res) {
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}
async function post(path, body, cookie) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, res: r };
}
async function get(path, cookie) {
  const r = await fetch(BASE + path, { headers: { cookie } });
  return r.json();
}

/** SSE 连接：记录每条 BID_ACCEPTED 的到达时间 */
function stream(path, cookie, onMsg) {
  const ac = new AbortController();
  (async () => {
    const res = await fetch(BASE + path, { headers: { cookie }, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(block)?.[1];
        const data = /data: (.*)/.exec(block)?.[1];
        if (ev === 'message' && data) onMsg(JSON.parse(data), Date.now());
      }
    }
  })();
  return () => ac.abort();
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const login = await post('/api/v1/auth/admin/login', { username: process.env.ADMIN_USER ?? 'admin', password: process.env.ADMIN_PASSWORD });
if (login.status !== 200) throw new Error('管理员登录失败');
const admin = cookieOf(login.res);
const ev = (await post('/api/v1/admin/events', { isDemo: true }, admin)).body.event;
const E = `/api/v1/admin/events/${ev.id}`;
const fr = await get(`${E}/first-round`, admin);
await post(`${E}/projects/wealth/publish-first-round`, { expectedDraftVersion: fr.projects.wealth.project.draftVersion, idempotencyKey: `perf-pub-${ev.id}`, confirm: true }, admin);
let st = await get(`${E}/state`, admin);
await post(`${E}/projects/wealth/control`, { action: 'START', expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `perf-start-${ev.id}` }, admin);

// 16 个领导会话
const units = (await get(`${E}/units`, admin)).units;
const leaders = [];
for (const u of units) {
  const cred = (await post(`${E}/units/${u.unitCode}/credentials`, {}, admin)).body;
  const token = new URL(cred.joinUrl).hash.slice(3);
  const ex = await post('/api/v1/auth/bidder/exchange', { token });
  const cookie = cookieOf(ex.res);
  await post(`/api/v1/bidder/events/${ev.id}/projects/wealth/base-ack`, { idempotencyKey: `perf-ack-${ev.id}-${u.unitCode}` }, cookie);
  leaders.push({ ...u, cookie, version: 0 });
}

// 2 块大屏 + 1 个管理端 + 16 个领导端推送连接
const key1 = (await post(`${E}/screen-keys`, { label: '压测屏1' }, admin)).body;
const key2 = (await post(`${E}/screen-keys`, { label: '压测屏2' }, admin)).body;
const screens = [];
for (const k of [key1, key2]) {
  const ex = await post('/api/v1/auth/screen/exchange', { key: new URL(k.screenUrl).hash.slice(3) });
  screens.push(cookieOf(ex.res));
}
const head = (await get(`${E}/state`, admin)).seq;
const arrivals = new Map(); // seq -> [arrival times at screens]
const closers = screens.map((c) =>
  stream(`/api/v1/screen/events/${ev.id}/stream?since=${head}`, c, (m, at) => {
    if (m.type !== 'BID_ACCEPTED') return;
    arrivals.set(m.seq, [...(arrivals.get(m.seq) ?? []), at]);
  }),
);
closers.push(stream(`${E}/stream?since=${head}`, admin, () => {}));
for (const l of leaders) closers.push(stream(`/api/v1/bidder/events/${ev.id}/stream?since=${head}`, l.cookie, () => {}));
await new Promise((r) => setTimeout(r, 500));

const latencies = [];
const submitMs = [];
let accepted = 0;
for (const groupNo of [1, 2, 3]) {
  st = await get(`${E}/state`, admin);
  await post(`${E}/projects/wealth/control`, { action: 'OPEN_GROUP', groupNo, expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `perf-open-${ev.id}-${groupNo}` }, admin);
  const group = leaders.filter((l) => l.groupNo === groupNo);
  for (let round = 0; round < ROUNDS; round++) {
    // 本组所有领导同时提交
    await Promise.all(
      group.map(async (l) => {
        const me = await get(`/api/v1/bidder/events/${ev.id}/me`, l.cookie);
        const p = me.projects.wealth;
        const t0 = Date.now();
        const r = await post(
          `/api/v1/bidder/events/${ev.id}/projects/wealth/bids`,
          { targetIncreasePp: p.currentPp + 5, expectedBidVersion: p.bidVersion, idempotencyKey: `perf-${ev.id}-${l.unitCode}-${round}` },
          l.cookie,
        );
        submitMs.push(Date.now() - t0);
        if (r.status !== 201) throw new Error(`提交失败 ${JSON.stringify(r.body)}`);
        accepted++;
        const acceptedAt = Date.parse(r.body.receipt.acceptedAt);
        const seq = r.body.receipt.eventSequence;
        const deadline = Date.now() + 5000;
        while ((arrivals.get(seq)?.length ?? 0) < screens.length && Date.now() < deadline) await new Promise((x) => setTimeout(x, 5));
        for (const at of arrivals.get(seq) ?? []) latencies.push(at - acceptedAt);
        if ((arrivals.get(seq)?.length ?? 0) < screens.length) latencies.push(Infinity);
      }),
    );
  }
  st = await get(`${E}/state`, admin);
  await post(`${E}/projects/wealth/control`, { action: 'CLOSE_GROUP', groupNo, expectedControlVersion: st.projects.wealth.controlVersion, idempotencyKey: `perf-close-${ev.id}-${groupNo}` }, admin);
}
closers.forEach((c) => c());

const fin = latencies.filter(Number.isFinite);
const result = {
  在线连接: `${leaders.length} 个领导 + ${screens.length} 块大屏 + 1 个管理端`,
  成功报价: accepted,
  大屏收到推送次数: fin.length,
  丢失: latencies.length - fin.length,
  '服务端确认→大屏收到（毫秒）': { p50: pct(fin, 50), p95: pct(fin, 95), max: Math.max(...fin) },
  '手机提交往返（毫秒）': { p50: pct(submitMs, 50), p95: pct(submitMs, 95), max: Math.max(...submitMs) },
};
console.log(JSON.stringify(result, null, 2));
const ok = latencies.length === fin.length && pct(fin, 95) <= 2000;
console.log(ok ? '结论：达到「通常 ≤1 秒、95% ≤2 秒」目标' : '结论：未达到目标，请检查网络与服务器');
process.exit(ok ? 0 : 1);
