import {
  type FirstRoundBoard,
  type GroupBoard,
  LEADER_STATUS_LABELS,
  PROJECT_NAMES,
  type BidFeedItem,
  type ProjectCode,
  type ProjectView,
  type RealtimeMessage,
  type ScreenMode,
  isProjectCode,
} from '@bidding/shared';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DemoBadge } from '../../components/ui';
import { api, errorText, takeHashParam } from '../../lib/api';
import { fmtTime, wan2 } from '../../lib/format';
import { CONN_LABEL, type ConnState, useRealtime } from '../../lib/realtime';

interface PublicEvent {
  id: string;
  isDemo: boolean;
  name: string;
  currentProject: ProjectCode;
  screenMode: ScreenMode;
  screenProject: ProjectCode;
}

interface LiveSnapshot {
  seq: number;
  event: PublicEvent;
  project: ProjectView;
  published: boolean;
  groups: GroupBoard[];
  recentBids: BidFeedItem[];
}

interface FirstRoundSnapshot {
  seq: number;
  event: PublicEvent;
  board: FirstRoundBoard;
}

interface ResultGroup {
  groupNo: number;
  name: string;
  minIncreasePp: number;
  leaderStatus: string;
  rows: Array<{ unitCode: string; unitName: string; firstRoundPp: number; finalPp: number; addedPp: number; rank: number; isTop: boolean; leaderLabel: string }>;
}
interface ResultsSnapshot {
  seq: number;
  event: PublicEvent;
  projects: Record<ProjectCode, { projectCode: ProjectCode; name: string; status: string; locked: boolean; lockedAt?: string; groups: ResultGroup[] }>;
}

/** 大屏入口：凭证交换 → 按管理端指定模式（follow）或固定模式展示 */
export function ScreenPage({ mode }: { mode: ScreenMode | 'follow' }) {
  const [eventId, setEventId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const key = takeHashParam('k');
    (async () => {
      try {
        if (key) await api.post('/api/v1/auth/screen/exchange', { key });
        const s = await api.get<{ eventId: string }>('/api/v1/screen/session');
        setEventId(s.eventId);
      } catch (e) {
        setErr(key ? errorText(e) : '请使用管理端生成的大屏链接打开本页面');
      }
    })();
  }, []);

  if (err) return <div className="screen-key-page">{err}</div>;
  if (!eventId) return <div className="screen-key-page">正在连接…</div>;
  return mode === 'follow' ? <FollowScreen eventId={eventId} /> : <FixedScreen eventId={eventId} mode={mode} />;
}

function FixedScreen({ eventId, mode }: { eventId: string; mode: ScreenMode }) {
  const [params] = useSearchParams();
  const q = params.get('project');
  const project = q && isProjectCode(q) ? q : null;
  return <ModeView eventId={eventId} mode={mode} project={project} />;
}

/** 跟随管理端切换的大屏模式 */
function FollowScreen({ eventId }: { eventId: string }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const { data } = useRealtime<LiveSnapshot>(`${base}/live`, `${base}/stream`);
  if (!data) return <div className="screen-key-page">正在加载…</div>;
  return <ModeView key={`${data.event.screenMode}-${data.event.screenProject}`} eventId={eventId} mode={data.event.screenMode} project={data.event.screenProject} />;
}

function ModeView({ eventId, mode, project }: { eventId: string; mode: ScreenMode; project: ProjectCode | null }) {
  if (mode === 'FIRST_ROUND') return <FirstRoundScreen eventId={eventId} project={project} />;
  if (mode === 'RESULTS') return <ResultsScreen eventId={eventId} />;
  return <LiveScreen eventId={eventId} project={project} />;
}

// ------------------------------------------------------------------ 舞台缩放：按 1920×1080 设计，等比适配任意投影比例

function Stage({ children, isDemo }: { children: ReactNode; isDemo?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      if (ref.current) ref.current.style.transform = `translate(-50%, -50%) scale(${s})`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div className="screen-root">
      <DemoBadge show={isDemo} />
      <div className="screen-stage" ref={ref}>
        {children}
      </div>
    </div>
  );
}

function useScreenTools() {
  const [sound, setSound] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const chime = () => {
    if (!sound) return;
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.55);
    } catch {
      // 浏览器不支持声音时忽略
    }
  };
  const tools = (
    <div className="s-tools">
      <button className="s-tool" onClick={() => setSound((s) => !s)}>
        {sound ? '声音：开' : '声音：关'}
      </button>
      <button
        className="s-tool"
        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
      >
        全屏
      </button>
    </div>
  );
  return { tools, chime };
}

function ConnInfo({ conn, lastSyncAt }: { conn: ConnState; lastSyncAt: number | null }) {
  return (
    <div className="s-conn">
      {CONN_LABEL[conn]}
      <br />
      最近同步 {lastSyncAt ? fmtTime(new Date(lastSyncAt).toISOString()) : '—'}
    </div>
  );
}

function OfflineAlert({ conn }: { conn: ConnState }) {
  if (conn === 'live' || conn === 'connecting' || conn === 'polling') return null;
  return <div className="s-alert">连接中断，数据可能延迟</div>;
}

const STATUS_PILL: Record<string, string> = {
  DRAFT: '准备中',
  ROUND1_PUBLISHED: '首轮已发布',
  LIVE: '竞标进行中',
  PAUSED: '暂停',
  LOCKED: '已锁定',
};

function Head({ title, sub, right }: { title: string; sub: ReactNode; right: ReactNode }) {
  return (
    <div className="s-head">
      <div>
        <div className="s-title">{title}</div>
        <div className="s-sub">{sub}</div>
      </div>
      <div className="s-head-right">{right}</div>
    </div>
  );
}

// ------------------------------------------------------------------ 实时竞标大屏

function LiveScreen({ eventId, project }: { eventId: string; project: ProjectCode | null }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const { tools, chime } = useScreenTools();
  const chimeRef = useRef(chime);
  chimeRef.current = chime;
  const onMessage = (m: RealtimeMessage) => {
    if (m.type === 'BID_ACCEPTED' && m.unitCode) {
      setFlash((f) => ({ ...f, [m.unitCode!]: m.seq }));
      chimeRef.current();
    }
  };
  const { data, conn, lastSyncAt } = useRealtime<LiveSnapshot>(`${base}/live${project ? `?project=${project}` : ''}`, `${base}/stream`, onMessage);

  // 领先变化轻提示
  const prevTop = useRef<Record<number, string>>({});
  useEffect(() => {
    if (!data?.published) return;
    for (const g of data.groups) {
      const key = g.topUnitCodes.join(',');
      const prev = prevTop.current[g.groupNo];
      if (prev !== undefined && prev !== key && data.project.status === 'LIVE' && g.topUnitCodes.length) {
        const names = g.rows.filter((r) => g.topUnitCodes.includes(r.unitCode)).map((r) => r.unitName).join('、');
        setToast({ id: Date.now(), text: `${g.name}领先：${names} ${g.topPp}%` });
      }
      prevTop.current[g.groupNo] = key;
    }
  }, [data]);

  // 高亮约 2 秒后清除
  useEffect(() => {
    if (!Object.keys(flash).length) return;
    const t = setTimeout(() => setFlash({}), 2100);
    return () => clearTimeout(t);
  }, [flash]);

  if (!data) return <Stage>{null}</Stage>;
  const p = data.project;
  const openGroup = p.groups.find((g) => g.status === 'OPEN');
  const sub = (
    <>
      <span>{PROJECT_NAMES[p.projectCode]}专场</span>
      {openGroup && <span>当前：{openGroup.name}</span>}
    </>
  );
  return (
    <Stage isDemo={data.event.isDemo}>
      <Head
        title={data.event.name || '现场竞标'}
        sub={sub}
        right={
          <>
            <span className={`s-pill ${p.status === 'LIVE' ? 'live' : ''}`}>{STATUS_PILL[p.status]}</span>
            {tools}
          </>
        }
      />
      <OfflineAlert conn={conn} />
      {toast && (
        <div className="s-toast" key={toast.id}>
          {toast.text}
        </div>
      )}
      {!data.published ? (
        <div className="s-center-msg">
          {PROJECT_NAMES[p.projectCode]}首轮结果待现场发布
          <small>请稍候</small>
        </div>
      ) : (
        <div className="s-groups">
          {data.groups.map((g) => (
            <LiveGroup key={g.groupNo} g={g} flash={flash} anyOpen={!!openGroup} />
          ))}
        </div>
      )}
      <div className="s-foot">
        <div className="s-feed-label">最新加码</div>
        <div className="s-feed">
          {data.recentBids.length === 0 && <span className="s-feed-item">暂无</span>}
          {data.recentBids.map((b) => (
            <span className="s-feed-item num" key={b.bidId}>
              {b.unitName} {PROJECT_NAMES[b.projectCode]} {b.fromPp}% → <b>{b.toPp}%</b>
            </span>
          ))}
        </div>
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}

function LiveGroup({ g, flash, anyOpen }: { g: GroupBoard; flash: Record<string, number>; anyOpen: boolean }) {
  const stateText = g.status === 'OPEN' ? '进行中' : g.status === 'CLOSED' ? '已结束' : '等待';
  const leaderNames = g.rows.filter((r) => g.topUnitCodes.includes(r.unitCode)).map((r) => r.unitName).join('、');
  let leaderText: ReactNode;
  if (g.leaderStatus === 'CHAMPION_CANDIDATE') leaderText = <span className="s-leader">标王候选：{leaderNames}</span>;
  else if (g.leaderStatus === 'TIED_PENDING') leaderText = <span className="s-leader">并列领先·待确认：{leaderNames}</span>;
  else leaderText = <span className="s-leader none">暂无符合门槛的标王候选</span>;
  return (
    <div className={`s-group ${g.status === 'OPEN' ? 'open' : anyOpen ? 'dim' : ''}`}>
      <div className="s-group-head">
        <div className="s-group-name">
          {g.name}
          <span className="s-group-state">{stateText}</span>
        </div>
        <div className="s-group-meta">
          <span>最低增幅 {g.minIncreasePp}%</span>
          {leaderText}
        </div>
      </div>
      <div className="s-cols">
        <span>排名</span>
        <span>单位</span>
        <span>首轮</span>
        <span>当前增幅</span>
      </div>
      <div className="s-rows">
        {g.rows.map((r) => {
          const badge =
            r.isTop && g.leaderStatus === 'CHAMPION_CANDIDATE' ? (
              <span className="s-badge">标王候选</span>
            ) : r.isTop && g.leaderStatus === 'TIED_PENDING' ? (
              <span className="s-badge outline">并列领先</span>
            ) : r.isTop && g.leaderStatus === 'GROUP_LEADER' && g.topUnitCodes.length < g.rows.length ? (
              <span className="s-badge soft">{LEADER_STATUS_LABELS.GROUP_LEADER}</span>
            ) : null;
          return (
            <div key={`${r.unitCode}-${flash[r.unitCode] ?? 0}`} className={`s-row ${r.isTop ? 'top' : ''} ${flash[r.unitCode] ? 'flash' : ''}`}>
              <span className="s-rank num">{r.rank}</span>
              <span className="s-unit">
                {r.unitName}
                {badge}
              </span>
              <span className="s-first num">
                {r.firstRoundPp}
                <span className="pct">%</span>
              </span>
              <span className="s-current num">
                {r.currentPp}
                <span className="pct">%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 首轮大屏

function FirstRoundScreen({ eventId, project }: { eventId: string; project: ProjectCode | null }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const { tools } = useScreenTools();
  // 未指定项目时以当前专场为准
  const live = useRealtime<LiveSnapshot>(project ? null : `${base}/live`, project ? null : `${base}/stream`);
  const projectCode = project ?? live.data?.event.currentProject ?? null;
  const { data, conn, lastSyncAt } = useRealtime<FirstRoundSnapshot>(
    projectCode ? `${base}/projects/${projectCode}/first-round` : null,
    projectCode ? `${base}/stream` : null,
  );
  if (!data) return <Stage>{null}</Stage>;
  const b = data.board;
  return (
    <Stage isDemo={data.event.isDemo}>
      <Head
        title={data.event.name || '现场竞标'}
        sub={
          <>
            <span>{PROJECT_NAMES[b.projectCode]} · 会前首轮结果</span>
            {b.published && <span>发布于 {fmtTime(b.publishedAt)}</span>}
            {b.published && (
              <span>
                {b.completeCount}/{b.totalCount}家已录入
              </span>
            )}
          </>
        }
        right={
          <>
            <span className="s-pill">{b.published ? '首轮已发布' : '待发布'}</span>
            {tools}
          </>
        }
      />
      <OfflineAlert conn={conn} />
      {!b.published ? (
        <div className="s-center-msg">
          首轮结果待现场发布
          <small>{PROJECT_NAMES[b.projectCode]}专场</small>
        </div>
      ) : (
        <div className="s-groups">
          {b.groups.map((g) => (
            <div className="s-group" key={g.groupNo}>
              <div className="s-group-head">
                <div className="s-group-name">
                  {g.name}
                  <span className="s-group-state">{g.rows.length}家</span>
                </div>
                <div className="s-group-meta">
                  <span>最低增幅 {g.minIncreasePp}%</span>
                </div>
              </div>
              <div className="s-cols" style={{ gridTemplateColumns: g.rows[0]?.baseTargetWan !== undefined ? '64px 1fr 150px 150px' : '64px 1fr 120px 170px' }}>
                <span>排名</span>
                <span>单位</span>
                <span>{g.rows[0]?.baseTargetWan !== undefined ? '目标（万元）' : ''}</span>
                <span>首轮增幅</span>
              </div>
              <div className="s-rows">
                {g.rows.map((r) => (
                  <div
                    className={`s-row ${r.rank === 1 ? 'top' : ''}`}
                    key={r.unitCode}
                    style={{ gridTemplateColumns: r.baseTargetWan !== undefined ? '64px 1fr 150px 150px' : '64px 1fr 120px 170px' }}
                  >
                    <span className="s-rank num">{r.rank ?? '—'}</span>
                    <span className="s-unit">{r.unitName}</span>
                    <span className="s-first num">{r.targetWan ? wan2(r.targetWan) : ""}</span>
                    {r.firstRoundPp === null ? (
                      <span className="s-missing">待录入</span>
                    ) : (
                      <span className="s-current num">
                        {r.firstRoundPp}
                        <span className="pct">%</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="s-foot">
        <div className="s-feed-label">说明</div>
        <div className="s-feed">
          <span className="s-feed-item">首轮为会前上报数据，现场加码从首轮起算，首轮快照不会被覆盖</span>
        </div>
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}

// ------------------------------------------------------------------ 最终结果大屏

function ResultsScreen({ eventId }: { eventId: string }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const { tools } = useScreenTools();
  const { data, conn, lastSyncAt } = useRealtime<ResultsSnapshot>(`${base}/results`, `${base}/stream`);
  if (!data) return <Stage>{null}</Stage>;
  return (
    <Stage isDemo={data.event.isDemo}>
      <Head title={data.event.name || '现场竞标'} sub={<span>现场竞标结果</span>} right={tools} />
      <OfflineAlert conn={conn} />
      <div className="s-results">
        {(['wealth', 'fund'] as ProjectCode[]).map((pc) => {
          const pr = data.projects[pc];
          return (
            <div className="s-result-project" key={pc}>
              <div className="s-result-label">{pr.name}</div>
              {pr.locked ? (
                pr.groups.map((g) => (
                  <div className="s-result-group" key={g.groupNo}>
                    <h3>
                      {g.name}
                      <span className="s-badge soft">
                        {g.leaderStatus === 'CHAMPION_CANDIDATE' ? '现场标王' : g.leaderStatus === 'TIED_PENDING' ? '并列·待确认' : '未达30%门槛'}
                      </span>
                    </h3>
                    {g.rows.map((r) => (
                      <div className={`s-result-row ${r.isTop ? 'top' : ''}`} key={r.unitCode}>
                        <span className="num">{r.rank}</span>
                        <span className="name">
                          {r.unitName}
                          {r.leaderLabel === '现场标王' && <span className="s-badge" style={{ marginLeft: 8 }}>现场标王</span>}
                        </span>
                        <span className="first num">首轮 {r.firstRoundPp}%</span>
                        <span className="final num">{r.finalPp}%</span>
                      </div>
                    ))}
                  </div>
                ))
              ) : (
                <div className="s-result-group" style={{ gridColumn: 'span 3', alignItems: 'center', justifyContent: 'center', fontSize: 34, color: 'var(--gold-soft)', letterSpacing: 6 }}>
                  {pr.status === 'DRAFT' ? '待开始' : '竞标进行中，待锁定后公布'}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="s-foot" style={{ height: 60 }}>
        <div className="s-feed-label">说明</div>
        <div className="s-feed">
          <span className="s-feed-item">以上为现场竞标结果，与活动结束后的实际业务达标考核区分</span>
        </div>
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}
