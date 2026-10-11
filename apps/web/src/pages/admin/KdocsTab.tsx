import { useEffect, useState } from 'react';
import { api, errorText } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import type { TabProps } from './EventPage';

interface Overview {
  binding: {
    webhookUrl: string;
    tokenMasked: string;
    intervalSec: number;
    maxRows: number;
    enabled: boolean;
    baselineDone: boolean;
    enabledAt: string | null;
    isMock: boolean;
  } | null;
  status: {
    state: 'STOPPED' | 'RUNNING' | 'ERROR' | 'READ_ONLY';
    lastOkAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    consecutiveFailures: number;
    lastDurationMs: number | null;
    calls: number;
    failures: number;
    missingUnits: string[];
  } | null;
  mockAvailable: boolean;
  counts: Record<string, number>;
  rows: Array<{
    unitCode: string;
    unitName: string;
    rowNo: number;
    targetRaw: string | null;
    status: 'APPLIED' | 'REJECTED' | 'PREEXISTING';
    message: string;
    seenAt: string;
  }>;
}

const STATUS_CHIP: Record<string, [string, string]> = {
  APPLIED: ['green', '已生效'],
  REJECTED: ['red', '未生效'],
  PREEXISTING: ['grey', '同步前已填写'],
};

export function KdocsTab({ eventId }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}/kdocs`;
  const [ov, setOv] = useState<Overview | null>(null);
  const [form, setForm] = useState({ webhookUrl: '', token: '', intervalSec: 3, maxRows: 40 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<Overview>(base)
      .then((o) => {
        setOv(o);
        return o;
      })
      .catch((e) => setMsg({ ok: false, text: errorText(e) }));

  useEffect(() => {
    void load().then((o) => {
      if (o && o.binding) setForm({ webhookUrl: o.binding.webhookUrl, token: '', intervalSec: o.binding.intervalSec, maxRows: o.binding.maxRows });
    });
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [eventId]);

  const run = async (fn: () => Promise<unknown>, okText: (r: any) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, text: okText(r) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const b = ov?.binding ?? null;
  const st = ov?.status ?? null;
  const save = (enabled?: boolean) =>
    run(
      () =>
        api.put(base, {
          ...(form.webhookUrl.trim() ? { webhookUrl: form.webhookUrl.trim() } : {}),
          ...(form.token.trim() ? { token: form.token.trim() } : {}),
          intervalSec: Number(form.intervalSec),
          maxRows: Number(form.maxRows),
          ...(enabled !== undefined ? { enabled } : {}),
        }),
      () => {
        setForm((f) => ({ ...f, token: '' }));
        return enabled === true ? '已开启同步' : enabled === false ? '已停止同步' : '已保存';
      },
    );

  const mockLink = b?.isMock ? `/mock-kdocs?file=${encodeURIComponent(/\/file\/([^/]+)\//.exec(b.webhookUrl)?.[1] ?? '')}` : null;

  return (
    <div className="a-grid" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(300px,2fr)' }}>
      <div>
        <div className="a-card">
          <h3>金山文档接入</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            领导在金山文档（微信内打开）中本单位的工作表里填写「加到多少」并选「确认」；本程序每隔几秒读取一次，按与手机端相同的规则处理，并把结果写回表格。
            详细步骤见《金山文档接入说明》。
          </p>
          <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>
              下载<a href={`${base}/template.xlsx`}>填报表模板</a>，导入金山文档（或直接使用模拟金山文档演练）。
            </li>
            <li>
              在该表格中打开 AirScript 脚本编辑器，粘贴<a href="/api/v1/admin/kdocs/airscript.js">同步脚本</a>，保存。
            </li>
            <li>生成「脚本令牌」，复制脚本的 webhook 链接，填到下方并保存。</li>
            <li>「测试连接」→「初始化表格版式」→ 设置各工作表权限 → 「开启同步」。</li>
          </ol>
          <div className="form-grid">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>脚本 webhook 链接</span>
              <input
                value={form.webhookUrl}
                onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
                placeholder="https://www.kdocs.cn/api/v3/ide/file/…/script/…/sync_task"
              />
            </label>
            <label className="field">
              <span>脚本令牌（AirScript-Token）{b ? `：已保存 ${b.tokenMasked}，留空不修改` : ''}</span>
              <input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            </label>
            <label className="field">
              <span>同步间隔（秒）</span>
              <input type="number" min={1} max={60} value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>每家报价行数</span>
              <input type="number" min={5} max={200} value={form.maxRows} onChange={(e) => setForm({ ...form, maxRows: Number(e.target.value) })} />
            </label>
          </div>
          <div className="a-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy || !form.webhookUrl} onClick={() => void save()}>
              保存配置
            </button>
            <button
              className="btn"
              disabled={busy || !b}
              onClick={() =>
                void run(
                  () => api.post(`${base}/test`),
                  (r) => `连接成功（${r.durationMs} 毫秒）。${r.missingUnits.length ? `缺少工作表：${r.missingUnits.join('、')}` : '16 家单位工作表齐全。'}`,
                )
              }
            >
              测试连接
            </button>
            <button
              className="btn"
              disabled={busy || !b}
              title="写入标题、信息区标签、表头和序号；不会改动领导已填写的内容"
              onClick={() => void run(() => api.post(`${base}/init-layout`, { clearInputs: false }), (r) => `已写入版式（${r.written} 处）${r.missingUnits.length ? `；缺少工作表：${r.missingUnits.join('、')}` : ''}`)}
            >
              初始化表格版式
            </button>
            {b?.enabled ? (
              <button className="btn btn-danger" disabled={busy} onClick={() => void save(false)}>
                停止同步
              </button>
            ) : (
              <button className="btn btn-primary" disabled={busy || !b} onClick={() => void save(true)}>
                开启同步
              </button>
            )}
            {b?.enabled && (
              <button className="btn" disabled={busy} onClick={() => void run(() => api.post(`${base}/sync-now`), () => '已立即同步')}>
                立即同步
              </button>
            )}
          </div>
          {msg && (
            <div className={`notice ${msg.ok ? 'success' : ''}`} style={{ marginTop: 10 }}>
              {msg.text}
            </div>
          )}
        </div>

        <div className="a-card">
          <h3>演练与重新测试</h3>
          {ov?.mockAvailable && (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                没有金山账号也能完整演练：使用本机「模拟金山文档」，它执行的就是同一份同步脚本。模拟表格页面可以在手机上打开（与电脑同一 Wi-Fi）。
              </p>
              <div className="a-row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  disabled={busy || !!b?.enabled}
                  onClick={() =>
                    void run(
                      () => api.post<Overview>(`${base}/use-mock`),
                      (r: Overview) => {
                        if (r.binding) setForm((f) => ({ ...f, webhookUrl: r.binding!.webhookUrl, token: '' }));
                        return '已切换到模拟金山文档并写好版式，可以「开启同步」了';
                      },
                    )
                  }
                >
                  使用模拟金山文档
                </button>
                {mockLink && (
                  <a className="btn" href={mockLink} target="_blank" rel="noreferrer">
                    打开模拟表格（领导填写页）
                  </a>
                )}
              </div>
            </>
          )}
          <p className="small muted">
            同一张表格反复测试：新建一个演示活动，绑定同一个链接；首次开启同步时，表格里已有的报价行会标记为「开始同步前已填写」，不参与新活动。
            也可以先停止同步，再清空各单位的填写区。
          </p>
          <button
            className="btn btn-danger"
            disabled={busy || !b || b.enabled}
            onClick={() => {
              if (!window.confirm('将清空 16 张单位工作表中领导填写的内容和处理结果（B11、报价行 B–E 列）。确定继续？')) return;
              void run(() => api.post(`${base}/init-layout`, { clearInputs: true }), () => '已清空填写区并重写版式');
            }}
          >
            清空表格填写区（需先停止同步）
          </button>
        </div>
      </div>

      <div>
        <div className="a-card">
          <h3>同步状态</h3>
          {!b ? (
            <p className="muted">尚未配置</p>
          ) : (
            <table className="a-table">
              <tbody>
                <tr>
                  <td>状态</td>
                  <td>
                    {!b.enabled ? (
                      <span className="chip grey">未开启</span>
                    ) : st?.state === 'ERROR' ? (
                      <span className="chip red">异常</span>
                    ) : st?.state === 'READ_ONLY' ? (
                      <span className="chip gold">只读维护中，暂停同步</span>
                    ) : (
                      <span className="chip green">同步中</span>
                    )}
                    {b.isMock && <span className="chip gold" style={{ marginLeft: 6 }}>模拟金山文档</span>}
                  </td>
                </tr>
                <tr>
                  <td>最近成功</td>
                  <td>
                    {st?.lastOkAt ? fmtTime(st.lastOkAt) : '—'}
                    {st?.lastDurationMs != null && <span className="small muted">（耗时 {st.lastDurationMs} 毫秒）</span>}
                  </td>
                </tr>
                {st?.state === 'ERROR' && (
                  <tr>
                    <td>错误</td>
                    <td style={{ color: 'var(--red)' }}>
                      {st.lastError}（连续 {st.consecutiveFailures} 次，{st.lastErrorAt ? fmtTime(st.lastErrorAt) : ''}）
                    </td>
                  </tr>
                )}
                {!!st?.missingUnits.length && (
                  <tr>
                    <td>缺少工作表</td>
                    <td style={{ color: 'var(--red)' }}>{st.missingUnits.join('、')}</td>
                  </tr>
                )}
                <tr>
                  <td>调用次数</td>
                  <td>
                    {st?.calls ?? 0}（失败 {st?.failures ?? 0}）
                  </td>
                </tr>
                <tr>
                  <td>处理行数</td>
                  <td>
                    已生效 {ov?.counts.APPLIED ?? 0} · 未生效 {ov?.counts.REJECTED ?? 0} · 同步前已填写 {ov?.counts.PREEXISTING ?? 0}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="small muted">结束本组、暂停、锁定前，系统会先自动读取一次表格，把最后几秒的填写读进来。</p>
        </div>

        <div className="a-card">
          <h3>最近处理的填写</h3>
          {!ov?.rows.length ? (
            <p className="muted">暂无</p>
          ) : (
            <table className="a-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>单位</th>
                  <th>行</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {ov.rows.map((r) => (
                  <tr key={`${r.unitCode}-${r.rowNo}`}>
                    <td className="small">{fmtTime(r.seenAt)}</td>
                    <td>{r.unitName}</td>
                    <td>
                      {r.rowNo}
                      <span className="small muted">（{r.targetRaw || '空'}）</span>
                    </td>
                    <td>
                      <span className={`chip ${STATUS_CHIP[r.status][0]}`}>{STATUS_CHIP[r.status][1]}</span> <span className="small">{r.message}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
