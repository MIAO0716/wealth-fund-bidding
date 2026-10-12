import { LEADER_STATUS_LABELS, PROJECT_STATUS_NAMES, type LiveRow, type ProjectCode, type ScreenMode } from '@bidding/shared';
import { useEffect, useState } from 'react';
import { KdocsReadBar } from '../../components/KdocsRead';
import { StepPicker } from '../../components/StepPicker';
import { Modal } from '../../components/ui';
import { ApiError, api, errorText, newIdempotencyKey } from '../../lib/api';
import { fmtTime, previewTargetWan, wan2 } from '../../lib/format';
import type { TabProps } from './EventPage';

type Action = 'START' | 'PAUSE' | 'RESUME' | 'OPEN_GROUP' | 'CLOSE_GROUP' | 'LOCK';

export function ControlTab({ eventId, state, reload }: TabProps) {
  const [project, setProject] = useState<ProjectCode>(state.event.currentProject);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmFor, setConfirmFor] = useState<{ title: string; body?: string; run: () => Promise<void> } | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [proxyBid, setProxyBid] = useState<{ row: LiveRow; groupOpen: boolean; acknowledged: boolean } | null>(null);
  const base = `/api/v1/admin/events/${eventId}`;
  const p = state.projects[project];
  const boards = state.boards[project];
  const acks = new Map(state.acks[project].map((a) => [a.unitCode, a]));

  const control = async (action: Action, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ kdocsWarning?: string }>(`${base}/projects/${project}/control`, {
        action,
        expectedControlVersion: p.controlVersion,
        idempotencyKey: newIdempotencyKey('ctl'),
        ...extra,
      });
      // 金山文档最后一次读取失败：操作已执行，但提醒核对表格
      setMsg(r.kdocsWarning ? { ok: false, text: `操作成功。注意：${r.kdocsWarning}` } : { ok: true, text: '操作成功' });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      reload();
      // 金山表格有单位没读到：默认拦截结束本组/锁定；核对后确认可继续（记入审计）
      if (e instanceof ApiError && e.code === 'KDOCS_INCOMPLETE' && extra.kdocsForce !== true) {
        const units: string[] = e.details?.units ?? [];
        setConfirmFor({
          title: '金山表格没有全部读取成功',
          body: `有 ${units.length} 家没有读取成功（${units.join('、')}）。已电话或现场核对过这些单位的最后报价，仍要继续？`,
          run: () => control(action, { ...extra, kdocsForce: true }),
        });
      }
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
    setConfirmFor({
      title: `代记底标确认：${unitName}`,
      body: `替${unitName}领导确认认领基础底标（已与领导现场确认）？`,
      run: async () => {
        await api.post(`${base}/projects/${project}/units/${unitCode}/base-ack`, { idempotencyKey: newIdempotencyKey('ack') });
        setMsg({ ok: true, text: `${unitName}底标确认已代记` });
        reload();
      },
    });

  const openGroup = (groupNo: number, closed: boolean) => {
    // 首轮已发布、尚未开始：一步完成「开始竞标 + 开放本组」
    if (p.status === 'ROUND1_PUBLISHED') return safe(() => control('START', { groupNo }))();
    if (!closed) return safe(() => control('OPEN_GROUP', { groupNo }))();
    setConfirmFor({ title: `重新开放第${groupNo}组`, body: '该组领导可以继续追加，原增幅保持不变。确认重新开放？', run: () => control('OPEN_GROUP', { groupNo }) });
  };

  const openGroupNo = p.groups.find((g) => g.status === 'OPEN')?.groupNo;
  const isCurrent = state.event.currentProject === project;
  const canOpenGroups = ['ROUND1_PUBLISHED', 'LIVE', 'PAUSED'].includes(p.status) && !openGroupNo;
  const nextWaiting = p.groups.find((g) => g.status === 'WAITING');

  /** 当前该做什么：给工作人员的明确提示 */
  const nextStep = (() => {
    if (p.status === 'DRAFT') return '下一步：到「首轮数据」发布首轮。';
    if (p.status === 'ROUND1_PUBLISHED') return '下一步：点下方第一组的「开放本组」，系统会自动开始竞标并开放该组（也可以先点「开始竞标」）。';
    if (p.status === 'LIVE' && openGroupNo) return `第${openGroupNo}组竞标中：本组领导可加码，不在线的单位可在下方榜单「代录」。结束后点「结束本组」。`;
    if (p.status === 'LIVE') return nextWaiting ? `下一步：开放第${nextWaiting.groupNo}组。` : '三组均已结束。';
    if (p.status === 'PAUSED') return nextWaiting ? `已暂停：点「恢复」继续，或直接开放第${nextWaiting.groupNo}组。` : '三组均已结束并自动暂停：核对无误后点「锁定项目」。';
    return `已于 ${fmtTime(p.lockedAt, true)} 锁定，结果不可修改。`;
  })();

  return (
    <>
      <KdocsReadBar eventId={eventId} compact onRead={reload} />
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
          <div className="notice info" style={{ marginTop: 12 }}>
            {nextStep}
          </div>
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
                    disabled={busy || !canOpenGroups}
                    title={
                      openGroupNo
                        ? `第${openGroupNo}组仍在进行，请先结束该组`
                        : p.status === 'DRAFT'
                          ? '请先发布首轮'
                          : p.status === 'LOCKED'
                            ? '项目已锁定'
                            : ''
                    }
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
        <p className="small muted" style={{ marginTop: -6 }}>
          「代记」替领导确认认领底标；「代录」替领导追加（该组进行中时），或在领导误操作时「下调更正」（锁定前随时可用，不低于首轮）。操作前会弹窗确认，全部记入审计。
        </p>
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
                                <span className="chip green">已认领{a.source === 'ADMIN_PROXY' ? '·代记' : a.source === 'KDOCS' ? '·金山' : ''}</span>
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
                                <button
                                  className="btn btn-sm"
                                  onClick={() => setProxyBid({ row: r, groupOpen: p.status === 'LIVE' && g.status === 'OPEN', acknowledged: !!a?.acknowledged })}
                                  disabled={p.status !== 'LIVE' && p.status !== 'PAUSED'}
                                  title={p.status === 'LIVE' || p.status === 'PAUSED' ? '代录追加，或下调更正' : '竞标开始后可用'}
                                >
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
                <td>
                  {b.source === 'ADMIN_PROXY' ? (
                    <span className="chip gold">代录</span>
                  ) : b.source === 'ADMIN_CORRECTION' ? (
                    <span className="chip red">更正</span>
                  ) : b.source === 'KDOCS' ? (
                    <span className="chip">金山文档</span>
                  ) : (
                    <span className="chip">领导</span>
                  )}
                </td>
                <td className="small muted">{fmtTime(b.acceptedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmFor && <ConfirmModal title={confirmFor.title} body={confirmFor.body} onClose={() => setConfirmFor(null)} run={confirmFor.run} />}
      {lockOpen && (
        <LockModal
          base={base}
          project={project}
          onClose={() => setLockOpen(false)}
          onLock={async (extra) => {
            await control('LOCK', { confirm: true, ...extra });
            setLockOpen(false);
          }}
        />
      )}
      {proxyBid && (
        <ProxyBidModal
          base={base}
          project={project}
          row={proxyBid.row}
          groupOpen={proxyBid.groupOpen}
          acknowledged={proxyBid.acknowledged}
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

function ConfirmModal({ title, body, run, onClose }: { title: string; body?: string; run: () => Promise<void>; onClose: () => void }) {
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
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await run();
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
      {body && <p style={{ marginTop: 0 }}>{body}</p>}
      <p className="small muted">确认后立即执行，并记入审计。</p>
      {err && <div className="notice">{err}</div>}
    </Modal>
  );
}

function LockModal(props: {
  base: string;
  project: ProjectCode;
  onClose: () => void;
  onLock: (extra: { earlyLock?: boolean }) => Promise<void>;
}) {
  const { base, project, onClose, onLock } = props;
  const [preview, setPreview] = useState<{
    tieWarnings: Array<{ message: string }>;
    unfinishedGroups: Array<{ groupNo: number; name: string; statusText: string }>;
  } | null>(null);
  const [checked, setChecked] = useState(false);
  const [early, setEarly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get(`${base}/projects/${project}/lock-preview`)
      .then(setPreview)
      .catch((e) => setErr(errorText(e)));
  }, [base, project]);
  const name = project === 'wealth' ? '理财' : '基金';
  const unfinished = preview?.unfinishedGroups ?? [];
  const earlyOk = !unfinished.length || early;
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
            disabled={!checked || busy || !preview || !earlyOk}
            onClick={async () => {
              setBusy(true);
              try {
                await onLock(unfinished.length ? { earlyLock: true } : {});
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {unfinished.length ? '确认提前收场并锁定' : '确认锁定'}
          </button>
        </>
      }
    >
      <ul style={{ paddingLeft: 18, lineHeight: 1.8 }}>
        <li>生成不可修改的结果快照，之后领导和管理员均不能追加；</li>
        <li>锁定前已提交的加码全部计入，之后的提交全部拒绝；</li>
        {project === 'wealth' && <li>理财锁定后，领导手机自动转到基金专场，可开始基金竞标。</li>}
      </ul>
      {preview?.tieWarnings.map((t) => (
        <div className="notice" key={t.message} style={{ marginBottom: 8 }}>
          {t.message}。系统不会自动认定唯一标王；如需组织追加，可先重新开放该组。
        </div>
      ))}
      {unfinished.length > 0 && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <b>
            {unfinished.map((g) => `${g.name}（${g.statusText}）`).join('、')}尚未结束。
          </b>
          正常锁定要求各组都已结束。确需提前收场，请单独勾选确认（记入审计）：
          <label className="a-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} />
            确认提前收场：以上分组不再竞标，按当前结果锁定
          </label>
        </div>
      )}
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
  groupOpen: boolean;
  acknowledged: boolean;
  steps: number[];
  highPp: number;
  onClose: () => void;
  onDone: (t: string) => void;
}) {
  const { row } = props;
  const canUp = props.groupOpen && props.acknowledged;
  const canDown = row.currentPp > row.firstRoundPp;
  const [mode, setMode] = useState<'up' | 'down'>(canUp || !canDown ? 'up' : 'down');
  const [step, setStep] = useState(props.steps[0] ?? 1);
  const [downTo, setDownTo] = useState(Math.max(row.firstRoundPp, row.currentPp - 1));
  const [high, setHigh] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const to = mode === 'up' ? row.currentPp + step : downTo;
  const needHigh = mode === 'up' && to >= props.highPp;
  const downOk = Number.isInteger(downTo) && downTo < row.currentPp && downTo >= row.firstRoundPp;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const url = `${props.base}/projects/${props.project}/units/${row.unitCode}/${mode === 'up' ? 'bids' : 'correct'}`;
      const r = await api.post(url, {
        targetIncreasePp: to,
        expectedBidVersion: row.bidVersion,
        idempotencyKey: newIdempotencyKey(mode === 'up' ? 'proxy' : 'fix'),
        ...(mode === 'up' ? { confirmHighValue: needHigh && high } : {}),
      });
      props.onDone(
        `${mode === 'up' ? '已代录' : '已更正'} ${row.unitName} ${r.receipt.fromPp}% → ${r.receipt.toPp}%（回执 ${r.receipt.receiptNo}）`,
      );
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const upBlocked = !props.groupOpen ? '本组不在进行中，不能代录追加（可下调更正）' : !props.acknowledged ? '请先「代记」底标确认' : null;
  return (
    <Modal
      title={`代录：${row.unitName}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            className={`btn ${mode === 'down' ? 'btn-danger-outline' : 'btn-primary'}`}
            onClick={() => void submit()}
            disabled={busy || (mode === 'up' ? !!upBlocked || (needHigh && !high) : !downOk)}
          >
            {mode === 'up' ? `确认代录 +${step} 个百分点` : `确认下调为 ${downTo}%`}
          </button>
        </>
      }
    >
      <div className="a-row" style={{ marginBottom: 12 }}>
        <button className={`btn btn-sm ${mode === 'up' ? 'btn-primary' : ''}`} onClick={() => setMode('up')}>
          代录追加
        </button>
        <button className={`btn btn-sm ${mode === 'down' ? 'btn-primary' : ''}`} onClick={() => setMode('down')} disabled={!canDown}>
          下调更正（误操作）
        </button>
      </div>
      {mode === 'up' ? (
        <>
          <StepPicker steps={props.steps} value={step} onChange={setStep} disabled={busy} />
          {upBlocked && <div className="notice" style={{ marginTop: 8 }}>{upBlocked}</div>}
        </>
      ) : (
        <>
          <label className="field">
            <span>
              更正后的增幅（%）：须低于当前 {row.currentPp}%，且不低于首轮 {row.firstRoundPp}%
            </span>
            <input
              type="number"
              inputMode="numeric"
              aria-label="更正后的增幅"
              min={row.firstRoundPp}
              max={row.currentPp - 1}
              value={Number.isFinite(downTo) ? downTo : ''}
              onChange={(e) => setDownTo(e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)))}
            />
          </label>
          <p className="small muted">用于领导误操作后按其真实意愿改回。大屏与领导手机立即更新，流水中标注「工作人员更正」。</p>
        </>
      )}
      <div className="m-confirm-row num">
        <span className="from">{row.currentPp}%</span>
        <span className="arrow">→</span>
        <span className="to">{Number.isFinite(to) ? `${to}%` : '—'}</span>
      </div>
      {row.baseTargetWan && Number.isFinite(to) && (
        <p className="num" style={{ textAlign: 'center' }}>
          目标 {wan2(previewTargetWan(row.baseTargetWan, to))} 万元
        </p>
      )}
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
