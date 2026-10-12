import type { FirstRoundBoard, ImportValidationResult, ProjectCode, ProjectView } from '@bidding/shared';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/ui';
import { api, errorText, newIdempotencyKey } from '../../lib/api';
import { fmtTime, wan2 } from '../../lib/format';
import type { TabProps } from './EventPage';

interface DraftRow {
  unitCode: string;
  unitName: string;
  groupNo: number;
  baseTargetWan: string | null;
  firstRoundPp: number | null;
  targetWan: string | null;
  remark: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface FirstRoundAdmin {
  seq: number;
  draftVersion: number;
  projects: Record<ProjectCode, { project: ProjectView; draftRows: DraftRow[]; preview: FirstRoundBoard; snapshot: { id: string; batchNo: string; publishedAt: string } | null }>;
  batches: Array<{ batchId: string; source: string; fileName: string | null; draftVersion: number; committedAt: string; operator: string; summary: { total: number; creates: number; updates: number } }>;
}

export function FirstRoundTab({ eventId, state }: TabProps) {
  const [project, setProject] = useState<ProjectCode>(state.event.currentProject);
  const [data, setData] = useState<FirstRoundAdmin | null>(null);
  const [validation, setValidation] = useState<(ImportValidationResult & { skippedBlank?: number; fileName?: string }) | null>(null);
  const [edit, setEdit] = useState<DraftRow | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `/api/v1/admin/events/${eventId}`;

  const load = () => api.get<FirstRoundAdmin>(`${base}/first-round`).then(setData).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  useEffect(() => {
    void load();
  }, [state.seq]);

  if (!data) return <p className="muted">加载中…</p>;
  const pd = data.projects[project];
  const isDraft = pd.project.status === 'DRAFT';

  const upload = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post<ImportValidationResult>(`${base}/first-round/imports/upload`, fd, { timeoutMs: 30_000 });
      setValidation({ ...r, fileName: file.name });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const commit = async () => {
    if (!validation?.validationId) return;
    setBusy(true);
    try {
      const r = await api.post(`${base}/first-round/imports/commit`, {
        validationId: validation.validationId,
        expectedDraftVersion: validation.draftVersion,
        idempotencyKey: newIdempotencyKey('imp'),
      });
      setValidation(null);
      setMsg({ ok: true, text: `已写入 ${r.rowCount} 行，批次 ${r.batchId.slice(0, 8)}，草稿版本 ${r.draftVersion}` });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="a-row" style={{ marginBottom: 12 }}>
        {(['wealth', 'fund'] as ProjectCode[]).map((p) => (
          <button key={p} className={`btn ${p === project ? 'btn-primary' : ''}`} onClick={() => setProject(p)}>
            {p === 'wealth' ? '理财' : '基金'}首轮
          </button>
        ))}
        <span className="chip">{isDraft ? '草稿（未发布）' : `已发布 ${fmtTime(pd.project.publishedAt, true)}`}</span>
        <span className="chip gold">
          完整性 {pd.preview.completeCount}/{pd.preview.totalCount}
        </span>
      </div>
      {msg && (
        <div className={`notice ${msg.ok ? 'success' : ''}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      <div className="a-card">
        <h3>
          导入首轮数据
          <span className="a-row">
            <a className="btn btn-sm" href="/api/v1/admin/first-round/template.xlsx">
              下载 Excel 模板
            </a>
            <a className="btn btn-sm" href="/api/v1/admin/first-round/template.csv">
              下载 CSV 模板
            </a>
          </span>
        </h3>
        <div className="a-row">
          <input ref={fileRef} type="file" accept=".xlsx,.csv" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} disabled={busy} />
          <span className="small muted">
            支持 .xlsx / .csv；可只含理财 16 行、基金 16 行或全部 32 行；底标与增幅都留空的行会被跳过。增幅填整数百分点（30% 填 30）。任一行错误整批不写入。
          </span>
        </div>
      </div>

      <div className="a-card">
        <h3>
          {project === 'wealth' ? '理财' : '基金'}草稿与快照
          {isDraft ? (
            <button className="btn btn-primary" onClick={() => setPublishOpen(true)} disabled={pd.preview.completeCount < 16}>
              发布首轮并冻结
            </button>
          ) : (
            pd.snapshot && <span className="chip green">快照 {pd.snapshot.batchNo} · 已冻结</span>
          )}
        </h3>
        <div className="a-scroll">
          <table className="a-table">
            <thead>
              <tr>
                <th>组别</th>
                <th>单位</th>
                <th className="r">基础底标（万元）</th>
                <th className="r">首轮增幅</th>
                <th className="r">首轮目标（万元）</th>
                <th>备注</th>
                <th>最近修改</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pd.draftRows.map((r) => (
                <tr key={r.unitCode}>
                  <td>第{r.groupNo}组</td>
                  <td>
                    {r.unitName} <span className="muted small">{r.unitCode}</span>
                  </td>
                  <td className="r num">{r.baseTargetWan ? wan2(r.baseTargetWan) : <span className="muted">待录入</span>}</td>
                  <td className="r num">{r.firstRoundPp !== null ? `${r.firstRoundPp}%` : <span className="muted">待录入</span>}</td>
                  <td className="r num">{wan2(r.targetWan)}</td>
                  <td className="small">{r.remark}</td>
                  <td className="small muted">{r.updatedAt ? `${fmtTime(r.updatedAt, true)} ${r.updatedBy ?? ''}` : ''}</td>
                  <td className="r">
                    {isDraft && (
                      <button className="btn btn-sm" onClick={() => setEdit(r)}>
                        录入/修改
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isDraft && <p className="small muted">首轮发布后底标与首轮值不可覆盖或删改。如发现基础数据错误，请暂停并导出记录，新建关联原活动的新活动。</p>}
      </div>

      <div className="a-card">
        <h3>首轮榜单预览（{isDraft ? '仅管理员可见，大屏未发布前显示「待现场发布」' : '已发布快照'}）</h3>
        <div className="board3">
          {pd.preview.groups.map((g) => (
            <div className="board-group" key={g.groupNo}>
              <h4>
                {g.name} <span className="small muted">最低 {g.minIncreasePp}%</span>
              </h4>
              <table className="a-table">
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.unitCode}>
                      <td style={{ width: 30 }}>{r.rank ?? '—'}</td>
                      <td>{r.unitName}</td>
                      <td className="r num">{r.firstRoundPp !== null ? `${r.firstRoundPp}%` : <span className="muted">待录入</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      <div className="a-card">
        <h3>导入批次</h3>
        {data.batches.length === 0 ? (
          <p className="muted small">暂无</p>
        ) : (
          <table className="a-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>来源</th>
                <th>操作者</th>
                <th>时间</th>
                <th className="r">行数</th>
                <th className="r">草稿版本</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.batchId}>
                  <td className="num small">{b.batchId.slice(0, 8)}</td>
                  <td>
                    {b.source}
                    {b.fileName ? ` · ${b.fileName}` : ''}
                  </td>
                  <td>{b.operator}</td>
                  <td>{fmtTime(b.committedAt, true)}</td>
                  <td className="r">{b.summary.total}</td>
                  <td className="r">{b.draftVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {validation && (
        <ValidationModal v={validation} busy={busy} onCancel={() => setValidation(null)} onCommit={() => void commit()} />
      )}
      {edit && (
        <EditModal
          row={edit}
          project={project}
          draftVersion={data.draftVersion}
          base={base}
          onClose={() => setEdit(null)}
          onSaved={(t) => {
            setEdit(null);
            setMsg({ ok: true, text: t });
            void load();
          }}
        />
      )}
      {publishOpen && (
        <PublishModal
          base={base}
          project={project}
          view={pd.project}
          completeCount={pd.preview.completeCount}
          onClose={() => setPublishOpen(false)}
          onDone={(t) => {
            setPublishOpen(false);
            setMsg({ ok: true, text: t });
            void load();
          }}
        />
      )}
    </>
  );
}

function ValidationModal({ v, busy, onCancel, onCommit }: { v: ImportValidationResult & { skippedBlank?: number; fileName?: string }; busy: boolean; onCancel: () => void; onCommit: () => void }) {
  return (
    <Modal
      wide
      title={`校验结果${v.fileName ? `：${v.fileName}` : ''}`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {v.valid ? '取消' : '关闭并修改文件'}
          </button>
          <button className="btn btn-primary" onClick={onCommit} disabled={!v.valid || busy}>
            整体提交 {v.summary.total} 行
          </button>
        </>
      }
    >
      <div className="a-row" style={{ marginBottom: 10 }}>
        <span className={`chip ${v.valid ? 'green' : 'red'}`}>{v.valid ? '全部通过' : `${v.summary.errors} 行有错误，整批不能提交`}</span>
        <span className="chip">新增 {v.summary.creates}</span>
        <span className="chip">修改 {v.summary.updates}</span>
        <span className="chip">不变 {v.summary.unchanged}</span>
        {v.skippedBlank ? <span className="chip grey">跳过空行 {v.skippedBlank}</span> : null}
        <span className="chip gold">
          导入后完整性：理财 {v.completenessAfter.wealth.complete}/16 · 基金 {v.completenessAfter.fund.complete}/16
        </span>
      </div>
      <div className="a-scroll">
        <table className="a-table">
          <thead>
            <tr>
              <th>行</th>
              <th>项目</th>
              <th>单位</th>
              <th className="r">底标（万元）</th>
              <th className="r">首轮增幅</th>
              <th className="r">目标（万元）</th>
              <th>变化</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.index} className={r.status === 'ERROR' ? 'err' : ''}>
                <td>{r.sourceRow}</td>
                <td>{r.projectCode === 'wealth' ? '理财' : r.projectCode === 'fund' ? '基金' : '—'}</td>
                <td>
                  {r.unitName ?? r.unitCode ?? '—'}
                </td>
                <td className="r num">{r.baseTargetWan ?? '—'}</td>
                <td className="r num">{r.firstRoundIncreasePp !== null ? `${r.firstRoundIncreasePp}%` : '—'}</td>
                <td className="r num">{wan2(r.previewTargetWan)}</td>
                <td className="small">
                  {r.action === 'UPDATE' && r.previous
                    ? `原 ${r.previous.baseTargetWan ?? '空'} / ${r.previous.firstRoundIncreasePp ?? '空'}%`
                    : r.action === 'CREATE'
                      ? '新增'
                      : r.action === 'UNCHANGED'
                        ? '不变'
                        : ''}
                </td>
                <td className="err-text">{r.errors.join('；')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function EditModal(props: { row: DraftRow; project: ProjectCode; draftVersion: number; base: string; onClose: () => void; onSaved: (t: string) => void }) {
  const { row } = props;
  const [baseWan, setBase] = useState(row.baseTargetWan ?? '');
  const [pp, setPp] = useState(row.firstRoundPp !== null ? String(row.firstRoundPp) : '');
  const [remark, setRemark] = useState(row.remark ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`${props.base}/first-round/drafts/${props.project}/${row.unitCode}`, {
        baseTargetWan: baseWan.trim(),
        firstRoundIncreasePp: /^\d+(\.\d+)?$/.test(pp.trim()) ? Number(pp.trim()) : pp.trim(),
        remark: remark.trim() || null,
        expectedDraftVersion: props.draftVersion,
        idempotencyKey: newIdempotencyKey('man'),
      });
      props.onSaved(`${row.unitName}已保存`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`手动录入：${props.project === 'wealth' ? '理财' : '基金'} · ${row.unitName}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            保存草稿
          </button>
        </>
      }
    >
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <label className="field">
          <span>基础底标（万元，正数，最多 6 位小数）</span>
          <input inputMode="decimal" value={baseWan} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="field">
          <span>首轮增幅（整数百分点，不低于组别门槛；30% 填 30）</span>
          <input inputMode="numeric" value={pp} onChange={(e) => setPp(e.target.value)} />
        </label>
        <label className="field">
          <span>备注</span>
          <input value={remark} onChange={(e) => setRemark(e.target.value)} />
        </label>
        {err && <div className="notice">{err}</div>}
      </div>
    </Modal>
  );
}

function PublishModal(props: { base: string; project: ProjectCode; view: ProjectView; completeCount: number; onClose: () => void; onDone: (t: string) => void }) {
  const [checked, setChecked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = props.project === 'wealth' ? '理财' : '基金';
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post(`${props.base}/projects/${props.project}/publish-first-round`, {
        expectedDraftVersion: props.view.draftVersion,
        idempotencyKey: newIdempotencyKey('pub'),
        confirm: true,
      });
      props.onDone(`${name}首轮已发布并冻结（${r.batchNo}），大屏已切换到首轮展示`);
    } catch (e) {
      const details = (e as { details?: { problems?: string[] } }).details;
      setErr(errorText(e) + (details?.problems ? `：${details.problems.slice(0, 8).join('；')}` : ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`发布${name}首轮（重大操作）`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={!checked || busy}>
            确认发布
          </button>
        </>
      }
    >
      <ul style={{ paddingLeft: 18, lineHeight: 1.8 }}>
        <li>冻结 16 家底标与首轮增幅，之后不可覆盖或删改；</li>
        <li>当前增幅从首轮起算，领导可开始确认认领底标；</li>
        <li>大屏切换到{name}首轮展示，完整首轮榜单将公开；</li>
        {props.project === 'fund' && <li>基金须在理财锁定后才能发布。</li>}
      </ul>
      <p>
        完整性：<b>{props.completeCount}/16</b>
      </p>
      <label className="a-row">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        我已核对 16 家底标与首轮数据，确认发布
      </label>
      {err && (
        <div className="notice" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </Modal>
  );
}
