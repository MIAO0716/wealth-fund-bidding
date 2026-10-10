import {
  type EventConfig,
  type EventSummary,
  type GroupBoard,
  PROJECT_STATUS_NAMES,
  type BidFeedItem,
  type ProjectCode,
  type ProjectView,
} from '@bidding/shared';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ConnLine, DemoBadge } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import type { AdminInfo } from './AdminApp';
import { AccessTab } from './AccessTab';
import { ControlTab } from './ControlTab';
import { ExportTab } from './ExportTab';
import { FirstRoundTab } from './FirstRoundTab';
import { MonitorTab } from './MonitorTab';

export interface AdminState {
  seq: number;
  event: EventSummary;
  projects: Record<ProjectCode, ProjectView>;
  boards: Record<ProjectCode, GroupBoard[]>;
  acks: Record<ProjectCode, Array<{ unitCode: string; unitName: string; acknowledged: boolean; acknowledgedAt: string | null; source: string | null }>>;
  recentBids: BidFeedItem[];
  failures: Array<{ id: number; projectCode: string; unitCode: string; actorType: string; operation: string; errorCode: string; message: string; createdAt: string }>;
}

export interface TabProps {
  eventId: string;
  state: AdminState;
  reload: () => void;
  me: AdminInfo;
}

export function EventPage({ me }: { me: AdminInfo }) {
  const { eventId = '' } = useParams();
  const base = `/api/v1/admin/events/${eventId}`;
  const { data, error, conn, lastSyncAt, reload } = useRealtime<AdminState>(`${base}/state`, `${base}/stream`);

  if (error) return <div className="notice">{error.message}</div>;
  if (!data) return <p className="muted">加载中…</p>;
  const props: TabProps = { eventId, state: data, reload, me };
  const ev = data.event;

  return (
    <>
      <DemoBadge show={ev.isDemo} />
      <div className="a-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0 }}>
            {ev.config.name || '（未命名活动）'} {ev.isDemo ? <span className="chip grey">演示</span> : <span className="chip red">正式</span>}
          </h2>
          <div className="small muted" style={{ marginTop: 4 }}>
            理财：{PROJECT_STATUS_NAMES[data.projects.wealth.status]} · 基金：{PROJECT_STATUS_NAMES[data.projects.fund.status]} · 大屏模式：
            {ev.screenMode === 'FIRST_ROUND' ? '首轮' : ev.screenMode === 'LIVE' ? '实时' : '结果'}（{ev.screenProject === 'wealth' ? '理财' : '基金'}）
          </div>
        </div>
        <ConnLine conn={conn} lastSyncAt={lastSyncAt} />
      </div>
      <nav className="a-tabs no-print">
        {[
          ['setup', '准备与配置'],
          ['first-round', '首轮数据'],
          ['control', '现场控制'],
          ['access', '二维码与大屏'],
          ['monitor', '监控与审计'],
          ['export', '导出与备份'],
        ].map(([path, label]) => (
          <NavLink key={path} to={`/admin/events/${eventId}/${path}`} className={({ isActive }) => `a-tab ${isActive ? 'on' : ''}`} style={{ textDecoration: 'none' }}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="setup" replace />} />
        <Route path="setup" element={<SetupTab {...props} />} />
        <Route path="first-round" element={<FirstRoundTab {...props} />} />
        <Route path="control" element={<ControlTab {...props} />} />
        <Route path="access" element={<AccessTab {...props} />} />
        <Route path="monitor" element={<MonitorTab {...props} />} />
        <Route path="export" element={<ExportTab {...props} />} />
      </Routes>
    </>
  );
}

interface Readiness {
  isDemo: boolean;
  configProblems: string[];
  projects: Record<ProjectCode, { status: string; problems: string[] }>;
  unitsWithoutCredential: string[];
}

function SetupTab({ eventId, state, reload }: TabProps) {
  const [cfg, setCfg] = useState<EventConfig>(state.event.config);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReadiness = () => api.get<Readiness>(`/api/v1/admin/events/${eventId}/readiness`).then(setReadiness).catch(() => {});
  useEffect(() => {
    void loadReadiness();
  }, [state.seq]);
  useEffect(() => {
    setCfg(state.event.config);
  }, [JSON.stringify(state.event.config)]);

  const set = <K extends keyof EventConfig>(k: K, v: EventConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.patch(`/api/v1/admin/events/${eventId}/config`, cfg);
      setMsg({ ok: true, text: '已保存' });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const toggleStep = (s: number) =>
    set('allowedIncrementSteps', cfg.allowedIncrementSteps.includes(s) ? cfg.allowedIncrementSteps.filter((x) => x !== s) : [...cfg.allowedIncrementSteps, s].sort((a, b) => a - b));

  const allProblems = readiness
    ? [
        ...readiness.configProblems,
        ...(['wealth', 'fund'] as ProjectCode[]).flatMap((p) => readiness.projects[p].problems.map((x) => `${p === 'wealth' ? '理财' : '基金'}：${x}`)),
      ]
    : [];

  return (
    <div className="a-grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(300px,1fr)' }}>
      <div className="a-card">
        <h3>活动配置</h3>
        <div className="form-grid">
          <label className="field">
            <span>活动名称</span>
            <input value={cfg.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field">
            <span>年度</span>
            <input type="number" value={cfg.year ?? ''} onChange={(e) => set('year', e.target.value ? Number(e.target.value) : null)} />
          </label>
          <label className="field">
            <span>活动日期（会话有效期覆盖当天）</span>
            <input type="date" value={cfg.eventDate ?? ''} onChange={(e) => set('eventDate', e.target.value || null)} />
          </label>
          <label className="field">
            <span>业务指标名称</span>
            <input value={cfg.metricName} onChange={(e) => set('metricName', e.target.value)} placeholder="由组织者填写" />
          </label>
          <label className="field">
            <span>金额统计口径（如销量或AUM净增，系统不会自行等同）</span>
            <input value={cfg.amountBasis} onChange={(e) => set('amountBasis', e.target.value)} />
          </label>
          <label className="field">
            <span>统计周期</span>
            <input value={cfg.statPeriod} onChange={(e) => set('statPeriod', e.target.value)} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>数据来源说明</span>
            <input value={cfg.dataSource} onChange={(e) => set('dataSource', e.target.value)} />
          </label>
          <label className="field">
            <span>二维码有效期（小时，默认 720 = 30 天）</span>
            <input type="number" min={1} value={cfg.qrValidHours} onChange={(e) => set('qrValidHours', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>大增幅再次确认阈值（%，不是上限）</span>
            <input type="number" min={5} step={5} value={cfg.highValueConfirmPp} onChange={(e) => set('highValueConfirmPp', Number(e.target.value))} />
          </label>
          <div className="field">
            <span>允许追加档位（百分点）</span>
            <div className="a-row">
              {[5, 10, 15, 20].map((s) => (
                <label key={s} className="a-row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={cfg.allowedIncrementSteps.includes(s)} onChange={() => toggleStep(s)} />+{s}
                </label>
              ))}
            </div>
            <span className="small">若组织者要求「每次只能追加5个百分点」，只勾选 +5。</span>
          </div>
          <label className="field">
            <span>会场 Wi-Fi 名称（选填，印在领导使用卡上，手机相机扫码即可连接）</span>
            <input value={cfg.wifiSsid} onChange={(e) => set('wifiSsid', e.target.value)} placeholder="例如：Meeting-5G" />
          </label>
          <label className="field">
            <span>会场 Wi-Fi 密码（开放网络留空）</span>
            <input value={cfg.wifiPassword} onChange={(e) => set('wifiPassword', e.target.value)} />
          </label>
          <label className="field">
            <span>首轮大屏展示底标与目标金额</span>
            <select value={cfg.showAmountsOnScreen ? '1' : '0'} onChange={(e) => set('showAmountsOnScreen', e.target.value === '1')}>
              <option value="0">不展示（默认，以增幅为主）</option>
              <option value="1">展示</option>
            </select>
          </label>
        </div>
        <div className="a-row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            保存配置
          </button>
          {msg && <span className={msg.ok ? 'chip green' : 'err-text'}>{msg.text}</span>}
        </div>
      </div>
      <div className="a-card">
        <h3>
          正式开启前检查
          <button className="btn btn-sm" onClick={() => void loadReadiness()}>
            刷新
          </button>
        </h3>
        {!readiness ? (
          <p className="muted">检查中…</p>
        ) : (
          <>
            {allProblems.length === 0 ? (
              <div className="notice success">配置与首轮数据均已就绪</div>
            ) : (
              <ul style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8, maxHeight: 360, overflow: 'auto' }}>
                {allProblems.map((p) => (
                  <li key={p} className="small">
                    {p}
                  </li>
                ))}
              </ul>
            )}
            {readiness.unitsWithoutCredential.length > 0 && (
              <p className="small muted">尚未发放二维码：{readiness.unitsWithoutCredential.length} 家</p>
            )}
            <p className="small muted">流程：导入首轮 → 发布理财首轮 → 领导认领底标 → 分组加码 → 暂停核对 → 锁定理财 → 基金同样流程 → 导出。</p>
          </>
        )}
      </div>
    </div>
  );
}
