import { ERROR_MESSAGES, type BidReceipt, type ProjectCode } from '@bidding/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnLine, DemoBadge, Modal } from '../components/ui';
import { ApiError, api, errorText, newIdempotencyKey } from '../lib/api';
import { fmtTime, previewTargetWan, wan2 } from '../lib/format';
import { useRealtime } from '../lib/realtime';

interface MeProject {
  projectCode: ProjectCode;
  name: string;
  status: 'DRAFT' | 'ROUND1_PUBLISHED' | 'LIVE' | 'PAUSED' | 'LOCKED';
  published: boolean;
  groupStatus: 'WAITING' | 'OPEN' | 'CLOSED';
  currentGroup: number | null;
  baseTargetWan: string | null;
  firstRoundPp: number | null;
  currentPp: number | null;
  currentTargetWan: string | null;
  bidVersion: number | null;
  baseAcknowledged: boolean;
  baseAcknowledgedAt: string | null;
  baseAckSource: string | null;
}

interface MeSnapshot {
  seq: number;
  event: {
    id: string;
    isDemo: boolean;
    name: string;
    metricName: string;
    currentProject: ProjectCode;
    allowedIncrementSteps: number[];
    highValueConfirmPp: number;
  };
  unit: { code: string; name: string; groupNo: number; groupName: string; minIncreasePp: number };
  projects: Record<ProjectCode, MeProject>;
  myBids: Array<{ receiptNo: string; projectCode: ProjectCode; fromPp: number; toPp: number; targetWan: string; source: string; acceptedAt: string }>;
}

/** 领导端状态用语（不出现「草稿」等内部术语） */
const LEADER_STATUS_TEXT: Record<MeProject['status'], string> = {
  DRAFT: '等待首轮发布',
  ROUND1_PUBLISHED: '首轮已发布，等待开始',
  LIVE: '竞标中',
  PAUSED: '已暂停',
  LOCKED: '已结束',
};

interface Pending {
  key: string;
  projectCode: ProjectCode;
  body: { targetIncreasePp: number; expectedBidVersion: number; idempotencyKey: string; confirmHighValue: boolean };
  fromPp: number;
}

export function BidPage() {
  const [session, setSession] = useState<{ eventId: string; unitCode: string } | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get('/api/v1/bidder/session')
      .then(setSession)
      .catch((e) => setSessionError(e instanceof ApiError && e.status === 401 ? ERROR_MESSAGES.SESSION_INVALID : errorText(e)));
  }, []);

  if (sessionError) return <SessionGone text={sessionError} />;
  if (!session) return <div className="center-page muted">加载中…</div>;
  return <BidMain eventId={session.eventId} />;
}

function SessionGone({ text }: { text: string }) {
  return (
    <div className="center-page">
      <div className="center-card">
        <h2>无法继续</h2>
        <p>{text}</p>
      </div>
    </div>
  );
}

function BidMain({ eventId }: { eventId: string }) {
  const base = `/api/v1/bidder/events/${eventId}`;
  const { data, error, conn, lastSyncAt, reload } = useRealtime<MeSnapshot>(`${base}/me`, `${base}/stream`);
  const [viewProject, setViewProject] = useState<ProjectCode | null>(null);
  const [step, setStep] = useState(5);
  const [confirming, setConfirming] = useState(false);
  const [highAck, setHighAck] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'warn' | 'info' | 'success'; text: string } | null>(null);
  const [receipt, setReceipt] = useState<BidReceipt | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const projectCode = viewProject ?? data?.event.currentProject ?? 'wealth';
  const p = data?.projects[projectCode];
  const steps = data?.event.allowedIncrementSteps ?? [5];

  useEffect(() => {
    if (!steps.includes(step)) setStep(steps.includes(5) ? 5 : steps[0]);
  }, [steps.join(','), step]);

  // 专场切换时回到当前专场
  useEffect(() => {
    setViewProject(null);
  }, [data?.event.currentProject]);

  const isCurrent = projectCode === data?.event.currentProject;
  const connOk = conn === 'live' || conn === 'polling';

  const blockReason = useMemo(() => {
    if (!p) return '加载中';
    if (pending) return '上一笔结果待核验';
    if (!isCurrent) return `${p.name}不是当前专场`;
    if (p.status === 'LOCKED') return ERROR_MESSAGES.PROJECT_LOCKED;
    if (p.status === 'PAUSED') return ERROR_MESSAGES.PROJECT_PAUSED;
    if (p.status !== 'LIVE') return '等待竞标开始';
    if (p.groupStatus === 'WAITING') return '尚未轮到本组，请等待';
    if (p.groupStatus === 'CLOSED') return '本组竞标已结束';
    if (!p.baseAcknowledged) return ERROR_MESSAGES.BASE_NOT_ACKNOWLEDGED;
    if (!connOk) return '连接异常，暂停提交，请稍候';
    return null;
  }, [p, pending, isCurrent, connOk]);

  const newPp = p?.currentPp !== null && p?.currentPp !== undefined ? p.currentPp + step : null;
  const newTarget = p?.baseTargetWan && newPp !== null ? previewTargetWan(p.baseTargetWan, newPp) : null;
  const needHighAck = newPp !== null && data ? newPp >= data.event.highValueConfirmPp : false;

  const handleBidError = useCallback(
    (e: unknown, pend: Pending) => {
      if (e instanceof ApiError && e.uncertain) {
        // 结果未知：不能新建报价，先核验同一请求
        setPending(pend);
        setMessage({ kind: 'warn', text: '网络异常，结果待核验。请勿重复操作，系统正在核验…' });
        return;
      }
      setPending(null);
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setMessage({ kind: 'warn', text: `当前增幅已更新为 ${e.details?.currentPp ?? ''}%，请重新确认` });
      } else {
        setMessage({ kind: 'warn', text: errorText(e) });
      }
      reload();
    },
    [reload],
  );

  const submit = async (pend: Pending) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.post<{ receipt: BidReceipt }>(`${base}/projects/${pend.projectCode}/bids`, pend.body, { timeoutMs: 12_000 });
      setPending(null);
      setReceipt(r.receipt);
      setMessage(null);
      setStep(steps.includes(5) ? 5 : steps[0]);
      reload();
    } catch (e) {
      handleBidError(e, pend);
    } finally {
      setBusy(false);
      setConfirming(false);
      setHighAck(false);
    }
  };

  const confirmBid = () => {
    if (!p || newPp === null || p.bidVersion === null) return;
    const key = newIdempotencyKey('bid');
    void submit({
      key,
      projectCode,
      fromPp: p.currentPp!,
      body: { targetIncreasePp: newPp, expectedBidVersion: p.bidVersion, idempotencyKey: key, confirmHighValue: needHighAck && highAck },
    });
  };

  // 结果待核验：查询同一请求
  const verify = useCallback(async () => {
    if (!pending) return;
    try {
      const r = await api.get(`${base}/requests/${pending.key}`, { timeoutMs: 8000 });
      if (r.status === 'SUCCEEDED') {
        setReceipt(r.response as BidReceipt);
        setPending(null);
        setMessage({ kind: 'success', text: '已核验：该笔追加已成功' });
        reload();
      } else if (r.status === 'FAILED') {
        setPending(null);
        setMessage({ kind: 'warn', text: `已核验：该笔未成功（${r.response?.error?.message ?? ''}）` });
        reload();
      } else {
        setMessage({ kind: 'warn', text: '服务器未收到该请求，可点击「用同一请求重试」' });
      }
    } catch {
      setMessage({ kind: 'warn', text: '网络仍不稳定，结果待核验，请稍候或联系工作人员' });
    }
  }, [pending, base, reload]);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void verify(), 3000);
    void verify();
    return () => clearInterval(t);
  }, [pending?.key]);

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post(`${base}/projects/${projectCode}/base-ack`, { idempotencyKey: newIdempotencyKey('ack') });
      setAckOpen(false);
      setMessage({ kind: 'success', text: '已确认认领基础底标' });
      reload();
    } catch (e) {
      setMessage({ kind: 'warn', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (error && (error.status === 401 || error.status === 403)) return <SessionGone text={ERROR_MESSAGES.SESSION_INVALID} />;
  if (!data || !p) return <div className="center-page muted">加载中…</div>;

  const statusText =
    p.status === 'LIVE'
      ? p.groupStatus === 'OPEN'
        ? '本组竞标中'
        : p.groupStatus === 'CLOSED'
          ? '本组已结束'
          : `等待本组（当前第${p.currentGroup ?? '—'}组）`
      : LEADER_STATUS_TEXT[p.status];

  return (
    <div className="m-page">
      <DemoBadge show={data.event.isDemo} />
      <header className="m-banner">
        <div className="m-event">{data.event.name || '现场竞标'}</div>
        <div className="m-unit">
          {data.unit.name}
          <small>{data.unit.groupName} · 最低 {data.unit.minIncreasePp}%</small>
        </div>
        <div className="m-tags">
          <span className="m-tag gold">{p.name}专场</span>
          <span className="m-tag">{statusText}</span>
        </div>
        <div className="m-switch" role="tablist">
          {(['wealth', 'fund'] as ProjectCode[]).map((c) => (
            <button key={c} className={c === projectCode ? 'on' : ''} onClick={() => setViewProject(c)}>
              {data.projects[c].name}
            </button>
          ))}
        </div>
      </header>

      <main className="m-body">
        <UsageGuide />
        <section className="m-card">
          <div className="m-current-label">当前已确认增幅</div>
          {p.currentPp !== null ? (
            <>
              <div className="m-current num">
                {p.currentPp}
                <span className="pct">%</span>
              </div>
              <div className="m-target">
                竞标目标 <b className="num">{wan2(p.currentTargetWan)}</b> 万元
              </div>
            </>
          ) : (
            <div className="m-current pending">{p.published ? '—' : '首轮结果待现场发布'}</div>
          )}
          <div className="m-kv">
            <div>
              基础底标（万元）
              <b className="num">{p.baseTargetWan ? wan2(p.baseTargetWan) : '待录入'}</b>
            </div>
            <div>
              会前首轮增幅
              <b className="num">{p.firstRoundPp !== null ? `${p.firstRoundPp}%` : '首轮结果待录入'}</b>
            </div>
          </div>
          {p.published && (
            <div style={{ marginTop: 12 }}>
              {p.baseAcknowledged ? (
                <span className="chip green">
                  已确认认领底标 {fmtTime(p.baseAcknowledgedAt)}
                  {p.baseAckSource === 'ADMIN_PROXY' ? '（工作人员代记）' : ''}
                </span>
              ) : (
                p.status !== 'LOCKED' && (
                  <button className="btn btn-gold" style={{ width: '100%', minHeight: 48 }} onClick={() => setAckOpen(true)}>
                    确认认领基础底标
                  </button>
                )
              )}
            </div>
          )}
        </section>

        {message && <div className={`notice ${message.kind === 'success' ? 'success' : message.kind === 'info' ? 'info' : ''}`}>{message.text}</div>}

        {pending && (
          <section className="m-card">
            <b>结果待核验</b>
            <p className="small muted">
              {pending.fromPp}% → {pending.body.targetIncreasePp}%。核验完成前不能发起新的追加。
            </p>
            <div className="a-row">
              <button className="btn" onClick={() => void verify()} disabled={busy}>
                立即核验
              </button>
              <button className="btn btn-primary" onClick={() => void submit(pending)} disabled={busy}>
                用同一请求重试
              </button>
            </div>
          </section>
        )}

        {receipt && receipt.projectCode === projectCode && !pending && (
          <section className="m-card m-receipt">
            <h4>追加成功 · 服务器已确认</h4>
            <table className="m-table">
              <tbody>
                <tr>
                  <td>回执号</td>
                  <td className="num">{receipt.receiptNo}</td>
                </tr>
                <tr>
                  <td>增幅</td>
                  <td className="num">
                    {receipt.fromPp}% → {receipt.toPp}%
                  </td>
                </tr>
                <tr>
                  <td>竞标目标</td>
                  <td className="num">{wan2(receipt.targetWan)} 万元</td>
                </tr>
                <tr>
                  <td>确认时间</td>
                  <td className="num">{fmtTime(receipt.acceptedAt)}</td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        {isCurrent && p.published && p.status !== 'LOCKED' && (
          <section className="m-card">
            <div className="m-current-label" style={{ marginBottom: 10 }}>
              选择追加档位（百分点）
            </div>
            <div className="m-steps" style={{ gridTemplateColumns: `repeat(${Math.min(steps.length, 4)}, 1fr)` }}>
              {steps.map((s) => (
                <button key={s} className={`m-step ${s === step ? 'on' : ''}`} onClick={() => setStep(s)} disabled={busy}>
                  +{s}
                  <small>个百分点</small>
                </button>
              ))}
            </div>
            <div className="m-preview">
              <span>
                追加后 <b className="num">{newPp ?? '—'}%</b>
              </span>
              <span className="num">目标 {wan2(newTarget)} 万元</span>
            </div>
            <button
              className="btn btn-primary m-main-btn"
              disabled={!!blockReason || busy}
              onClick={() => {
                setMessage(null);
                setReceipt(null);
                setConfirming(true);
              }}
            >
              {step === 5 ? '追加5个百分点' : `确认追加 +${step}`}
            </button>
            <div className="m-status-line">{blockReason ?? '确认后不可下调'}</div>
          </section>
        )}

        {data.myBids.filter((b) => b.projectCode === projectCode).length > 0 && (
          <section className="m-card m-history">
            <div className="m-current-label" style={{ marginBottom: 4 }}>
              本单位追加记录
            </div>
            {data.myBids
              .filter((b) => b.projectCode === projectCode)
              .map((b) => (
                <div className="m-history-row" key={b.receiptNo}>
                  <span className="num">
                    {b.fromPp}% → <b>{b.toPp}%</b>
                    {b.source === 'ADMIN_PROXY' ? '（代录）' : ''}
                  </span>
                  <span className="num">{fmtTime(b.acceptedAt)}</span>
                </div>
              ))}
          </section>
        )}

        <ConnLine conn={conn} lastSyncAt={lastSyncAt} />
      </main>

      {confirming && newPp !== null && (
        <Modal
          title="请确认本次追加"
          onClose={busy ? undefined : () => setConfirming(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                返回修改
              </button>
              <button className="btn btn-primary" onClick={confirmBid} disabled={busy || !!blockReason || (needHighAck && !highAck)}>
                {busy ? '提交中…' : '确认提交'}
              </button>
            </>
          }
        >
          <table className="m-table">
            <tbody>
              <tr>
                <td>项目</td>
                <td>{p.name}</td>
              </tr>
              <tr>
                <td>单位</td>
                <td>
                  {data.unit.name}（{data.unit.groupName}）
                </td>
              </tr>
            </tbody>
          </table>
          <div className="m-confirm-row num">
            <span className="from">{p.currentPp}%</span>
            <span className="arrow">→</span>
            <span className="to">{newPp}%</span>
          </div>
          <table className="m-table">
            <tbody>
              <tr>
                <td>本次追加</td>
                <td>+{step} 个百分点</td>
              </tr>
              <tr>
                <td>竞标目标</td>
                <td className="num">{wan2(newTarget)} 万元</td>
              </tr>
            </tbody>
          </table>
          {needHighAck && (
            <label className="notice" style={{ marginTop: 12 }}>
              <span>
                <input type="checkbox" checked={highAck} onChange={(e) => setHighAck(e.target.checked)} /> 本次增幅达到 {newPp}%，我已核对并明确确认
              </span>
            </label>
          )}
          <div className="m-irrev">确认后不可下调</div>
        </Modal>
      )}

      {ackOpen && p.baseTargetWan && (
        <Modal
          title="确认认领基础底标"
          onClose={busy ? undefined : () => setAckOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAckOpen(false)} disabled={busy}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void acknowledge()} disabled={busy}>
                确认认领
              </button>
            </>
          }
        >
          <table className="m-table">
            <tbody>
              <tr>
                <td>项目</td>
                <td>{p.name}</td>
              </tr>
              <tr>
                <td>单位</td>
                <td>{data.unit.name}</td>
              </tr>
              <tr>
                <td>基础底标</td>
                <td className="num">{wan2(p.baseTargetWan)} 万元</td>
              </tr>
              <tr>
                <td>会前首轮增幅</td>
                <td className="num">{p.firstRoundPp}%</td>
              </tr>
              {data.event.metricName && (
                <tr>
                  <td>业务指标</td>
                  <td>{data.event.metricName}</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 12 }}>
            本确认用于现场留痕，正式备案以会后签字台账为准。
          </p>
        </Modal>
      )}
    </div>
  );
}


const GUIDE_KEY = 'bid-guide-dismissed';

/** 首次进入的三步说明；关闭后本机不再显示（仅界面偏好，存 localStorage） */
function UsageGuide() {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) !== '1';
    } catch {
      return true;
    }
  });
  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      // 无痕模式等不可写时忽略
    }
  };
  return (
    <section className="m-card m-guide">
      <div className="m-guide-head">
        <span>使用说明（三步）</span>
        <button onClick={close}>知道了</button>
      </div>
      <ol>
        <li>首轮发布后，点「确认认领基础底标」</li>
        <li>轮到本组时，选择追加档位，点「追加」，核对后「确认提交」</li>
        <li>看到「追加成功 · 服务器已确认」即完成；增幅只增不减</li>
      </ol>
    </section>
  );
}
