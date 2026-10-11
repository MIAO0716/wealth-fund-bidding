import { UNITS, parseUnitFiles } from '@bidding/shared';
import { useEffect, useMemo, useState } from 'react';
import { KdocsReadBar } from '../../components/KdocsRead';
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
    mode: 'files' | 'single';
    autoSync: boolean;
    unitFiles: Array<{ unitCode: string; unitName: string; url: string | null }> | null;
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
    pace: 'HOT' | 'WARM' | 'COLD' | 'IDLE' | null;
    nextSyncAt: string | null;
  } | null;
  mockAvailable: boolean;
  reusable: { eventId: string; eventName: string; webhookUrl: string; updatedAt: string | null } | null;
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

interface ConnectResult {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
  overview: Overview;
}

const KDOCS_URL = /https:\/\/[A-Za-z0-9.-]*kdocs\.cn\/api\/v3\/ide\/file\/[A-Za-z0-9_-]+\/script\/[A-Za-z0-9_-]+\/sync_task/;

/** 链接和令牌一起粘贴进来时自动拆开 */
function splitPaste(text: string): { url: string; token: string } | null {
  const m = KDOCS_URL.exec(text);
  if (!m) return null;
  const rest = text.replace(m[0], ' ').split(/[\s,，;；]+/).filter((x) => x.length >= 8 && !/[：:]$/.test(x));
  return { url: m[0], token: rest.sort((a, b) => b.length - a.length)[0] ?? '' };
}

const PACE_TEXT: Record<string, string> = {
  HOT: '竞标中：按同步间隔读取',
  WARM: '等待中（未开始 / 组间 / 暂停）：每 10 秒',
  COLD: '首轮未发布：每 30 秒',
  IDLE: '已全部锁定：停止自动同步',
};

const STATUS_CHIP: Record<string, [string, string]> = {
  APPLIED: ['green', '已生效'],
  REJECTED: ['red', '未生效'],
  PREEXISTING: ['grey', '同步前已填写'],
};

export function KdocsTab({ eventId }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}/kdocs`;
  const [ov, setOv] = useState<Overview | null>(null);
  const [form, setForm] = useState({ webhookUrl: '', token: '', intervalSec: 3, maxRows: 40, autoSync: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<ConnectResult['steps'] | null>(null);
  const [enableAfter, setEnableAfter] = useState(true);
  const [mode, setMode] = useState<'files' | 'single'>('files');
  const [filesText, setFilesText] = useState('');
  const parsedFiles = useMemo(() => (filesText.trim() ? parseUnitFiles(filesText, UNITS, true) : null), [filesText]);
  const syncFromBinding = (bd: Overview['binding']) => {
    if (!bd) return;
    setMode(bd.mode);
    setFilesText((bd.unitFiles ?? []).filter((f) => f.url).map((f) => `${f.unitName} ${f.url}`).join('\n'));
  };

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
      if (o && o.binding) {
        setForm({ webhookUrl: o.binding.webhookUrl, token: '', intervalSec: o.binding.intervalSec, maxRows: o.binding.maxRows, autoSync: o.binding.autoSync });
        syncFromBinding(o.binding);
      }
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
          autoSync: form.autoSync,
          maxRows: Number(form.maxRows),
          ...(enabled !== undefined ? { enabled } : {}),
        }),
      (r: { stoppedEvents?: string[] }) => {
        setForm((f) => ({ ...f, token: '' }));
        const stopped = r.stoppedEvents?.length ? `；这张表格在「${r.stoppedEvents.join('」「')}」上的同步已自动停止` : '';
        return (enabled === true ? '已启用读取' : enabled === false ? '已停用读取' : '已保存') + stopped;
      },
    );

  const connect = async (opts: { reuse?: boolean }) => {
    setBusy(true);
    setMsg(null);
    setSteps(null);
    try {
      const r = await api.post<ConnectResult>(
        `${base}/connect`,
        opts.reuse
          ? { reuse: true, enable: enableAfter }
          : {
              ...(form.webhookUrl.trim() ? { webhookUrl: form.webhookUrl.trim() } : {}),
              ...(form.token.trim() ? { token: form.token.trim() } : {}),
              unitFiles: mode === 'files' ? filesText : '',
              enable: enableAfter,
            },
        { timeoutMs: 60_000 },
      );
      setSteps(r.steps);
      setOv(r.overview);
      if (r.overview.binding) {
        setForm((f) => ({ ...f, webhookUrl: r.overview.binding!.webhookUrl, token: '' }));
        syncFromBinding(r.overview.binding);
      }
      if (r.ok)
        setMsg({
          ok: true,
          text: enableAfter
            ? mode === 'files'
              ? '已连接。下一步：把 16 个单位文件分别只分享给对应单位的领导。现场看到表格有人填写后，点「读取金山表格」。'
              : '已连接。下一步：在金山文档中给各单位工作表设置权限，并分享给领导。现场看到表格有人填写后，点「读取金山表格」。'
            : '已连接。',
        });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const mockLinks: Array<{ label: string; href: string }> = !b?.isMock
    ? []
    : b.unitFiles
      ? b.unitFiles
          .filter((f) => f.url?.startsWith('mock://'))
          .map((f) => ({ label: f.unitName, href: `/mock-kdocs?file=${encodeURIComponent(f.url!.slice('mock://'.length))}` }))
      : [{ label: '打开模拟表格（领导填写页）', href: `/mock-kdocs?file=${encodeURIComponent(/\/file\/([^/]+)\//.exec(b.webhookUrl)?.[1] ?? '')}` }];

  return (
    <div className="a-grid" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(300px,2fr)' }}>
      <div>
        <div className="a-card">
          <h3>一键连接金山文档</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            领导在金山文档（微信内打开）本单位的工作表里填写「加到多少」并选「确认」；工作人员看到有人填写后点「读取金山表格」，程序读取一次，按与手机端相同的规则处理，并把结果写回表格。
          </p>
          <div className="kd-mode">
            <label className={mode === 'files' ? 'on' : ''}>
              <input type="radio" name="kd-mode" checked={mode === 'files'} onChange={() => setMode('files')} />
              <span>
                <b>每家单位一个文件（推荐）</b>
                <small>各单位只能打开自己的文件，互相看不到</small>
              </span>
            </label>
            <label className={mode === 'single' ? 'on' : ''}>
              <input type="radio" name="kd-mode" checked={mode === 'single'} onChange={() => setMode('single')} />
              <span>
                <b>一个文件 16 张工作表</b>
                <small>准备最简单，但各单位能看到彼此的工作表</small>
              </span>
            </label>
          </div>
          <details className="small" style={{ marginBottom: 10 }} open={!b && !ov?.reusable}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>第一次使用：在金山文档里准备（只需做一次，以后各场活动沿用）</summary>
            {mode === 'files' ? (
              <ol style={{ paddingLeft: 18, lineHeight: 1.8, margin: '6px 0 0' }}>
                <li>
                  下载<a href={`${base}/template-files.zip`}>模板压缩包</a>并解压：1 个「竞标总控」+ 16 个单位文件。在金山文档网页版把 17 个文件一起「导入」（不要改工作表名称）。
                </li>
                <li>
                  打开「竞标总控」→ AirScript 脚本编辑器（一般在「效率」→「高级开发」），新建共享脚本，粘贴<a href="/api/v1/admin/kdocs/airscript.js">同步脚本</a>全文，保存；在编辑器的「服务」中添加「云文档API」。
                </li>
                <li>在脚本编辑器中生成「脚本令牌」；在脚本的「…」菜单中「复制 webhook 链接」。</li>
                <li>逐个复制 16 个单位文件的分享链接，按「单位名称 链接」每行一家，粘贴到下面的清单里。</li>
                <li>每个单位文件只分享给对应单位的领导（可编辑）；「竞标总控」不要分享。</li>
              </ol>
            ) : (
              <ol style={{ paddingLeft: 18, lineHeight: 1.8, margin: '6px 0 0' }}>
                <li>
                  下载<a href={`${base}/template.xlsx`}>填报表模板</a>，在金山文档网页版「导入」成在线表格（不要改工作表名称）。
                </li>
                <li>
                  在该表格中打开 AirScript 脚本编辑器（一般在「效率」→「高级开发」），新建共享脚本，粘贴<a href="/api/v1/admin/kdocs/airscript.js">同步脚本</a>全文，保存。
                </li>
                <li>在脚本编辑器中生成「脚本令牌」；在脚本的「…」菜单中「复制 webhook 链接」。把两样粘贴到下面。</li>
              </ol>
            )}
          </details>

          {ov?.reusable && (!b || b.webhookUrl !== ov.reusable.webhookUrl) && (
            <div className="notice info" style={{ marginBottom: 10 }}>
              <div>
                <div>
                  上次使用的金山表格：来自活动「{ov.reusable.eventName}」{ov.reusable.updatedAt ? `（${fmtTime(ov.reusable.updatedAt, true)}）` : ''}
                </div>
                <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void connect({ reuse: true })}>
                  沿用这张表格，一键连接
                </button>
              </div>
            </div>
          )}

          <div className="form-grid">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>脚本 webhook 链接（可以把链接和令牌一起粘贴到这里）</span>
              <input
                value={form.webhookUrl}
                onChange={(e) => {
                  const v = e.target.value;
                  const sp = splitPaste(v);
                  if (sp && sp.url !== v.trim()) setForm({ ...form, webhookUrl: sp.url, token: sp.token || form.token });
                  else setForm({ ...form, webhookUrl: v });
                }}
                placeholder="https://www.kdocs.cn/api/v3/ide/file/…/script/…/sync_task"
              />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>脚本令牌（AirScript-Token）{b ? `：已保存 ${b.tokenMasked}，留空不修改` : ''}</span>
              <input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            </label>
            {mode === 'files' && (
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span>16 家单位文件链接（每行一家：单位名称 + 链接，顺序不限）</span>
                <textarea
                  rows={6}
                  value={filesText}
                  onChange={(e) => setFilesText(e.target.value)}
                  placeholder={'浦东 https://www.kdocs.cn/l/xxxxxxxx\n闵行 https://www.kdocs.cn/l/xxxxxxxx\n……'}
                  style={{ fontFamily: 'inherit', fontSize: 13 }}
                />
                {parsedFiles && (
                  <span className="small" style={{ color: parsedFiles.errors.length || parsedFiles.missing.length ? 'var(--red)' : 'var(--ok)' }}>
                    已识别 {Object.keys(parsedFiles.files).length} / 16 家
                    {parsedFiles.missing.length > 0 && parsedFiles.missing.length < 16 ? `；还缺：${parsedFiles.missing.join('、')}` : ''}
                    {parsedFiles.errors.length ? `；${parsedFiles.errors.slice(0, 2).join('；')}` : ''}
                  </span>
                )}
              </label>
            )}
          </div>
          <div className="a-row" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={busy || (!form.webhookUrl.trim() && !b)} onClick={() => void connect({})}>
              {busy ? '连接中…' : '一键连接'}
            </button>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableAfter} onChange={(e) => setEnableAfter(e.target.checked)} />
              连接后立即启用读取
            </label>
          </div>
          {steps && (
            <ul className="kd-steps">
              {steps.map((x) => (
                <li key={x.name} className={x.ok ? 'ok' : 'bad'}>
                  <b>{x.ok ? '✔' : '✘'} {x.name}</b>
                  <span>{x.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {msg && (
            <div className={`notice ${msg.ok ? 'success' : ''}`} style={{ marginTop: 10 }}>
              {msg.text}
            </div>
          )}

          <details style={{ marginTop: 14 }}>
            <summary className="small" style={{ cursor: 'pointer' }}>
              高级设置（同步间隔、报价行数、单独执行各步骤）
            </summary>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <label className="field" style={{ gridColumn: '1 / -1', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={form.autoSync} onChange={(e) => setForm({ ...form, autoSync: e.target.checked })} style={{ width: 'auto' }} />
                <span>自动定时读取（不推荐：会频繁调用金山文档。开启后：有组竞标时按同步间隔，等待/组间/暂停每 10 秒，首轮未发布每 30 秒）</span>
              </label>
              <label className="field">
                <span>同步间隔（秒，仅自动定时读取时使用）</span>
                <input type="number" min={1} max={60} value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>每家报价行数</span>
                <input type="number" min={5} max={200} value={form.maxRows} onChange={(e) => setForm({ ...form, maxRows: Number(e.target.value) })} />
              </label>
            </div>
            <div className="a-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy || (!form.webhookUrl && !b)} onClick={() => void save()}>
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
            </div>
          </details>
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
                      () => api.post<Overview>(`${base}/use-mock`, { mode }),
                      (r: Overview) => {
                        if (r.binding) {
                          setForm((f) => ({ ...f, webhookUrl: r.binding!.webhookUrl, token: '' }));
                          syncFromBinding(r.binding);
                        }
                        return '已切换到模拟金山文档并写好版式，可以「一键连接」了';
                      },
                    )
                  }
                >
                  使用模拟金山文档
                </button>
                {mockLinks.length === 1 && (
                  <a className="btn" href={mockLinks[0].href} target="_blank" rel="noreferrer">
                    {mockLinks[0].label}
                  </a>
                )}
              </div>
              {mockLinks.length > 1 && (
                <div className="kd-mock-links">
                  <span className="small muted">打开模拟的单位文件（领导填写页）：</span>
                  {mockLinks.map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
          <p className="small muted">
            同一张表格反复测试：新建一个演示活动，沿用同一张表格；首次启用时，表格里已有的报价行会标记为「开始同步前已填写」，不参与新活动。
            也可以先停用读取，再清空各单位的填写区。
          </p>
          <button
            className="btn btn-danger"
            disabled={busy || !b || b.enabled}
            onClick={() => {
              if (!window.confirm('将清空 16 张单位工作表中领导填写的内容和处理结果（B11、报价行 B–E 列）。确定继续？')) return;
              void run(() => api.post(`${base}/init-layout`, { clearInputs: true }), () => '已清空填写区并重写版式');
            }}
          >
            清空表格填写区（需先停用读取）
          </button>
        </div>
      </div>

      <div>
        <div className="a-card">
          <h3>读取状态</h3>
          {b?.enabled && <KdocsReadBar eventId={eventId} onRead={() => void load()} />}
          {!b ? (
            <p className="muted">尚未配置</p>
          ) : (
            <table className="a-table">
              <tbody>
                <tr>
                  <td>状态</td>
                  <td>
                    {!b.enabled ? (
                      <span className="chip grey">未启用</span>
                    ) : st?.state === 'ERROR' ? (
                      <span className="chip red">异常</span>
                    ) : st?.state === 'READ_ONLY' ? (
                      <span className="chip gold">只读维护中，暂停读取</span>
                    ) : (
                      <span className="chip green">{b.autoSync ? '已启用 · 自动定时读取' : '已启用 · 手动读取'}</span>
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
                {b.enabled && b.autoSync && st?.pace && (
                  <tr>
                    <td>同步节奏</td>
                    <td>
                      {PACE_TEXT[st.pace]}
                      {st.nextSyncAt && <span className="small muted">（下次 {fmtTime(st.nextSyncAt)}）</span>}
                    </td>
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
          {b && (
            <div className="a-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              {b.enabled ? (
                <button className="btn btn-danger" disabled={busy} onClick={() => void save(false)}>
                  停用读取
                </button>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>
                  启用读取
                </button>
              )}
            </div>
          )}
          <p className="small muted">
            默认手动读取：领导在金山表格中填写后，工作人员点「读取金山表格」读取一次并处理（「现场控制」页面顶部也有这个按钮）。
            为了不漏掉最后几秒的填写，结束本组、暂停、锁定前会先自动读取一次；发布首轮、开始、开放/结束本组、暂停、恢复、锁定后也会读取一次，把最新状态写到领导表格。
          </p>
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
