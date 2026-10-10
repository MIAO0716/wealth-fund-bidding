import { LEADER_STATUS_LABELS, PROJECT_STATUS_NAMES, type LiveRow, type ProjectCode, type ScreenMode } from '@bidding/shared';
import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui';
import { api, errorText, newIdempotencyKey } from '../../lib/api';
import { fmtTime, previewTargetWan, wan2 } from '../../lib/format';
import type { TabProps } from './EventPage';

type Action = 'START' | 'PAUSE' | 'RESUME' | 'OPEN_GROUP' | 'CLOSE_GROUP' | 'LOCK';

export function ControlTab({ eventId, state, reload }: TabProps) {
  const [project, setProject] = useState<ProjectCode>(state.event.currentProject);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<{ title: string; run: (reason: string) => Promise<void> } | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [proxyBid, setProxyBid] = useState<LiveRow | null>(null);
  const base = `/api/v1/admin/events/${eventId}`;
  const p = state.projects[project];
  const boards = state.boards[project];
  const acks = new Map(state.acks[project].map((a) => [a.unitCode, a]));

  const control = async (action: Action, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`${base}/projects/${project}/control`, {
        action,
        expectedControlVersion: p.controlVersion,
        idempotencyKey: newIdempotencyKey('ctl'),
        ...extra,
      });
      setMsg({ ok: true, text: '操作成功' });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      reload();
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const safe = (f: () => Promise<void>) => () => void f().catch(() => {});

  const screenMode = async (mode: ScreenMode) => {
    try {
      await api.post(`${base}/screen-mode`, { mode, projectCode: project });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  const proxyAck = (unitCode: string, unitName: string) =>
    setReasonFor({
      title: `代记底标确认：${unitName}`,
      run: async (reason) => {
        await api.post(`${base}/projects/${project}/units/${unitCode}/base-ack`, { reason, idempotencyKey: newIdempotencyKey('ack') });
        setMsg({ ok: true, text: `${unitName}底标确认已代记` });
        reload();
      },
    });

  const openGroup = (groupNo: number, closed: boolean) => {
    if (!closed) return safe(() => control('OPEN_GROUP', { groupNo }))();
    setReasonFor({ title: `重新开放第${groupNo}组（原增幅不会下调）`, run: (reason) => control('OPEN_GROUP', { groupNo, reason }) });
  };

  const openGroupNo = p.groups.find((g) => g.status === 'OPEN')?.groupNo;
  const isCurrent = state.event.currentProject === project;

  return (
    <>
      <div className="a-row" style={{ marginBottom: 12 }}>
        {(['wealth', 'fund'] as ProjectCode[]).map((c) => (
          <button key={c} className={`btn ${c === project ? 'btn-primary' : ''}`} onClick={() => setProject(c)}>
            {c === 'wealth' ? '理财' : '基金'}
          </button>
        ))}
        {!isCurrent && <span className="chip grey">非当前专场</span>}
      </div>
      {msg && (
        <div className={`notice ${msg.ok ? 'success' : ''}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      <div className="a-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <div className="a-card">
          <h3>
            项目状态
            <span className={`chip ${p.status === 'LIVE' ? 'red' : p.status === 'LOCKED' ? 'green' : ''}`}>{PROJECT_STATUS_NAMES[p.status]}</span>
          </h3>
          <div className="a-row">
            <button className="btn btn-primary" disabled={busy || p.status !== 'ROUND1_PUBLISHED'} onClick={safe(() => control('START'))}>
              开始竞标
            </button>
            <button className="btn" disabled={busy || p.status !== 'LIVE'} onClick={safe(() => control('PAUSE'))}>
              暂停
            </button>
            <button className="btn" disabled={busy || p.status !== 'PAUSED'} onClick={safe(() => control('RESUME'))}>
              恢复
            </button>
            <button className="btn btn-danger-outline" disabled={busy || p.status !== 'PAUSED'} onClick={() => setLockOpen(true)}>
              锁定项目…
            </button>
          </div>
          <p className="small muted">
            {p.status === 'DRAFT' && '请先在「首轮数据」发布首轮。'}
            {p.status === 'LIVE' && '锁定前请先暂停，核对后再锁定。'}
            {p.status === 'LOCKED' && `已于 ${fmtTime(p.lockedAt, true)} 锁定，结果不可修改。`}
          </p>
        </div>
        <div className="a-card">
          <h3>大屏展示</h3>
          <div className="a-row">
            {(
              [
                ['FIRST_ROUND', '首轮结果'],
                ['LIVE', '实时竞标'],
                ['RESULTS', '最终结果'],
              ] as [ScreenMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                className={`btn ${state.event.screenMode === m && state.event.screenProject === project ? 'btn-gold' : ''}`}
                onClick={() => void screenMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="small muted">大屏打开「/screen」链接时自动跟随此处切换。</p>
        </div>
      </div>

      <div className="a-card">
        <h3>分组控制</h3>
        <div className="board3">
          {p.groups.map((g) => (
            <div key={g.groupNo} className={`board-group ${g.status === 'OPEN' ? 'open' : ''}`} style={{ padding: 12 }}>
              <div className="a-row" style={{ justifyContent: 'space-between' }}>
                <b>
                  {g.name} <span className="small muted">最低 {g.minIncreasePp}%</span>
                </b>
                <span className={`chip ${g.status === 'OPEN' ? 'gold' : g.status === 'CLOSED' ? 'grey' : ''}`}>
                  {g.status === 'OPEN' ? '进行中' : g.status === 'CLOSED' ? '已结束' : '等待'}
                </span>
              </div>
              <div className="a-row" style={{ marginTop: 10 }}>
                {g.status === 'OPEN' ? (
                  <button className="btn btn-sm" disabled={busy} onClick={safe(() => control('CLOSE_GROUP', { groupNo: g.groupNo }))}>
                    结束本组
                  </button>
                ) : (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy || !!openGroupNo || !(p.status === 'LIVE' || p.status === 'PAUSED')}
                    onClick={() => openGroup(g.groupNo, g.status === 'CLOSED')}
                  >
                    {g.status === 'CLOSED' ? '重新开放…' : '开放本组'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="a-card">
        <h3>实时榜单（管理视图，含金额与底标确认）</h3>
        {boards.length === 0 ? (
          <p className="muted">首轮发布后显示</p>
        ) : (
          <div className="board3">
            {boards.map((g) => (
              <div key={g.groupNo} className={`board-group ${g.status === 'OPEN' ? 'open' : ''}`}>
                <h4>
                  {g.name}
                  <span className="small">
                    {g.leaderStatus === 'NONE' ? '' : LEADER_STATUS_LABELS[g.leaderStatus]}
                    {g.leaderStatus === 'TIED_PENDING' && ' · 授旗规则未确认'}
                  </span>
                </h4>
                <table className="a-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>单位</th>
                      <th className="r">首轮</th>
                      <th className="r">当前</th>
                      <th className="r">目标（万元）</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => {
                      const a = acks.get(r.unitCode);
                      return (
                        <tr key={r.unitCode}>
                          <td>{r.rank}</td>
                          <td>
                            {r.unitName}
                            <div className="small">
                              {a?.acknowledged ? (
                                <span className="chip green">已认领{a.source === 'ADMIN_PROXY' ? '·代记' : ''}</span>
                              ) : (
                                <span className="chip grey">未认领</span>
                              )}
                            </div>
                          </td>
                          <td className="r num">{r.firstRoundPp}%</td>
                          <td className="r num">
                            <b>{r.currentPp}%</b>
                          </td>
                          <td className="r num small">{wan2(r.targetWan)}</td>
                          <td className="r">
                            {p.status !== 'LOCKED' && (
                              <div className="a-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                                {!a?.acknowledged && (
                                  <button className="btn btn-sm" onClick={() => proxyAck(r.unitCode, r.unitName)}>
                                    代记
                                  </button>
                                )}
                                <button className="btn btn-sm" onClick={() => setProxyBid(r)} disabled={p.status !== 'LIVE' || g.status !== 'OPEN'}>
                                  代录
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="a-card">
        <h3>最近加码</h3>
        <table className="a-table">
          <tbody>
            {state.recentBids.slice(0, 12).map((b) => (
              <tr key={b.bidId}>
                <td className="num small">{b.receiptNo}</td>
                <td>{b.unitName}</td>
                <td>{b.projectCode === 'wealth' ? '理财' : '基金'}</td>
                <td className="num">
                  {b.fromPp}% → <b>{b.toPp}%</b>
                </td>
                <td>{b.source === 'ADMIN_PROXY' ? <span className="chip gold">代录</span> : <span className="chip">领导</span>}</td>
                <td className="small muted">{fmtTime(b.acceptedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reasonFor && <ReasonModal title={reasonFor.title} onClose={() => setReasonFor(null)} run={reasonFor.run} />}
      {lockOpen && (
        <LockModal
          base={base}
          project={project}
          onClose={() => setLockOpen(false)}
          onLock={async () => {
            await control('LOCK', { confirm: true });
            setLockOpen(false);
          }}
        />
      )}
      {proxyBid && (
        <ProxyBidModal
          base={base}
          project={project}
          row={proxyBid}
          steps={state.event.config.allowedIncrementSteps}
          highPp={state.event.config.highValueConfirmPp}
          onClose={() => setProxyBid(null)}
          onDone={(t) => {
            setProxyBid(null);
            setMsg({ ok: true, text: t });
            reload();
          }}
        />
      )}
    </>
  );
}

function ReasonModal({ title, run, onClose }: { title: string; run: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await run(reason.trim());
                onClose();
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            确认
          </button>
        </>
      }
    >
      <label className="field">
        <span>原因（必填，记入审计）</span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {err && <div className="notice">{err}</div>}
    </Modal>
  );
}

function LockModal({ base, project, onClose, onLock }: { base: string; project: ProjectCode; onClose: () => void; onLock: () => Promise<void> }) {
  const [preview, setPreview] = useState<{ tieWarnings: Array<{ message: string }> } | null>(null);
  const [checked, setChecked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get(`${base}/projects/${project}/lock-preview`)
      .then(setPreview)
      .catch((e) => setErr(errorText(e)));
  }, [base, project]);
  const name = project === 'wealth' ? '理财' : '基金';
  return (
    <Modal
      title={`锁定${name}（重大操作，不可退回）`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={!checked || busy || !preview}
            onClick={async () => {
              setBusy(true);
              try {
                await onLock();
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            确认锁定
          </button>
        </>
      }
    >
      <ul style={{ paddingLeft: 18, lineHeight: 1.8 }}>
        <li>生成不可修改的结果快照，之后领导和管理员均不能追加；</li>
        <li>锁定前已提交的加码全部计入，之后的提交全部拒绝；</li>
        {project === 'wealth' && <li>理财锁定后才可发布基金首轮。</li>}
      </ul>
      {preview?.tieWarnings.map((t) => (
        <div className="notice" key={t.message} style={{ marginBottom: 8 }}>
          {t.message}。系统不会自动认定唯一标王；如需组织追加，可先重新开放该组。
        </div>
      ))}
      <label className="a-row">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        已与现场核对三组结果，确认锁定
      </label>
      {err && (
        <div className="notice" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </Modal>
  );
}

function ProxyBidModal(props: {
  base: string;
  project: ProjectCode;
  row: LiveRow;
  steps: number[];
  highPp: number;
  onClose: () => void;
  onDone: (t: string) => void;
}) {
  const { row } = props;
  const [step, setStep] = useState(props.steps.includes(5) ? 5 : props.steps[0]);
  const [reason, setReason] = useState('');
  const [high, setHigh] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const to = row.currentPp + step;
  const needHigh = to >= props.highPp;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post(`${props.base}/projects/${props.project}/units/${row.unitCode}/bids`, {
        targetIncreasePp: to,
        expectedBidVersion: row.bidVersion,
        idempotencyKey: newIdempotencyKey('proxy'),
        reason: reason.trim(),
        confirmHighValue: needHigh && high,
      });
      props.onDone(`已代录 ${row.unitName} ${r.receipt.fromPp}% → ${r.receipt.toPp}%（回执 ${r.receipt.receiptNo}）`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`代录加码：${row.unitName}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !reason.trim() || (needHigh && !high)}>
            确认代录（不可下调）
          </button>
        </>
      }
    >
      <div className="m-steps" style={{ gridTemplateColumns: `repeat(${props.steps.length}, 1fr)` }}>
        {props.steps.map((s) => (
          <button key={s} className={`m-step ${s === step ? 'on' : ''}`} onClick={() => setStep(s)}>
            +{s}
          </button>
        ))}
      </div>
      <div className="m-confirm-row num">
        <span className="from">{row.currentPp}%</span>
        <span className="arrow">→</span>
        <span className="to">{to}%</span>
      </div>
      {row.baseTargetWan && <p className="num" style={{ textAlign: 'center' }}>目标 {wan2(previewTargetWan(row.baseTargetWan, to))} 万元</p>}
      <label className="field">
        <span>代录原因（必填，例如「网络中断，领导现场口头确认」）</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {needHigh && (
        <label className="a-row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} /> 增幅达到 {to}%，已与领导明确确认
        </label>
      )}
      {err && (
        <div className="notice" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </Modal>
  );
}
