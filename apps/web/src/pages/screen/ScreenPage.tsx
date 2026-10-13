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
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DemoBadge } from '../../components/ui';
import { api, errorText, takeHashParam } from '../../lib/api';
import { fenToYi2, fmtTime, increasePct2, wan0 } from '../../lib/format';
import { audioReady, playBidSound, playChampionSound, playGroupStartSound, unlockAudio } from '../../lib/sound';
import { CONN_LABEL, type ConnState, useRealtime } from '../../lib/realtime';

interface PublicEvent {
  id: string;
  isDemo: boolean;
  name: string;
  currentProject: ProjectCode;
  screenMode: ScreenMode;
  screenProject: ProjectCode;
  /** 大屏声音（管理端控制） */
  screenSound?: boolean;
  soundBid?: string;
  soundChampion?: string;
  soundGroupStart?: string;
}

/** 大屏声音设置（来自管理端配置） */
interface SoundCfg {
  on: boolean;
  bid?: string;
  champion?: string;
  groupStart?: string;
}
const soundOf = (e?: PublicEvent): SoundCfg => ({
  on: e?.screenSound !== false,
  bid: e?.soundBid,
  champion: e?.soundChampion,
  groupStart: e?.soundGroupStart,
});

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
  rows: Array<{ unitCode: string; unitName: string; firstRoundPp: number; finalPp: number; addedPp: number; rank: number; isTop: boolean; leaderLabel: string; targetWan?: string }>;
}
interface ResultsSnapshot {
  seq: number;
  event: PublicEvent;
  projects: Record<
    ProjectCode,
    { projectCode: ProjectCode; name: string; status: string; locked: boolean; lockedAt?: string; groups: ResultGroup[]; totals?: { baseFen: string; targetFen: string } }
  >;
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

/** 开放本组（开始竞标）时敲锣：监听实时消息，任何大屏模式下都会响 */
function useGroupStartSound(eventId: string) {
  const base = `/api/v1/screen/events/${eventId}`;
  const cfgRef = useRef<SoundCfg>({ on: false });
  const onMessage = (m: RealtimeMessage) => {
    if (m.type === 'GROUP_STATUS' && m.data.status === 'OPEN' && cfgRef.current.on) playGroupStartSound(cfgRef.current.groupStart);
  };
  const live = useRealtime<LiveSnapshot>(`${base}/live`, `${base}/stream`, onMessage);
  cfgRef.current = soundOf(live.data?.event);
  return live;
}

function FixedScreen({ eventId, mode }: { eventId: string; mode: ScreenMode }) {
  useGroupStartSound(eventId);
  const [params] = useSearchParams();
  const q = params.get('project');
  const project = q && isProjectCode(q) ? q : null;
  return <ModeView eventId={eventId} mode={mode} project={project} />;
}

/** 跟随管理端切换的大屏模式 */
function FollowScreen({ eventId }: { eventId: string }) {
  const { data } = useGroupStartSound(eventId);
  if (!data) return <div className="screen-key-page">正在加载…</div>;
  return <ModeView key={`${data.event.screenMode}-${data.event.screenProject}`} eventId={eventId} mode={data.event.screenMode} project={data.event.screenProject} />;
}

function ModeView({ eventId, mode, project }: { eventId: string; mode: ScreenMode; project: ProjectCode | null }) {
  if (mode === 'FIRST_ROUND') return <FirstRoundScreen eventId={eventId} project={project} />;
  if (mode === 'RESULTS') return <ResultsScreen eventId={eventId} />;
  if (mode === 'AWARDS') return <AwardsScreen eventId={eventId} />;
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

/** 大屏工具：全屏按钮、声音解锁提示、领导在线数。声音开关在管理端「现场控制」 */
function useScreenTools(eventId: string, sound: SoundCfg) {
  const [ready, setReady] = useState(audioReady());
  const [presence, setPresence] = useState<{ online: number; total: number } | null>(null);
  // 浏览器要求页面先有一次点击或按键才允许播放声音
  useEffect(() => {
    const unlock = () => {
      unlockAudio();
      setTimeout(() => setReady(audioReady()), 50);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  // 领导手机在线数：每 10 秒刷新
  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .get<{ online: number; total: number }>(`/api/v1/screen/events/${eventId}/presence`, { timeoutMs: 8000 })
        .then((r) => !stop && setPresence(r))
        .catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [eventId]);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const soundOn = sound.on;
  const tools = (
    <div className="s-tools">
      {presence && (
        <span className="s-online" title="领导手机在线数">
          <i />
          领导在线 <b className="num">{presence.online}</b>/{presence.total}
        </span>
      )}
      {soundOn && !ready && <span className="s-tool hint">点击任意处开启声音</span>}
      <button
        className="s-tool"
        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
      >
        全屏
      </button>
    </div>
  );
  return {
    tools,
    bidSound: () => soundRef.current.on && playBidSound(soundRef.current.bid),
    championSound: () => soundRef.current.on && playChampionSound(soundRef.current.champion),
  };
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

function Head({ title, sub, right, center }: { title: string; sub: ReactNode; right: ReactNode; center?: ReactNode }) {
  return (
    <div className={`s-head ${center ? 'with-center' : ''}`}>
      <div className="s-head-left">
        <div className="s-title">{title}</div>
        <div className="s-sub">{sub}</div>
      </div>
      {center && <div className="s-head-center">{center}</div>}
      <div className="s-head-right">{right}</div>
    </div>
  );
}

// ------------------------------------------------------------------ 实时竞标大屏

/** 当前展示的组：进行中的组；没有进行中时停留在最近开放过的组（显示该组最终结果）；尚未开始时为第一组 */
function focusGroupNo(p: ProjectView): number {
  return p.groups.find((g) => g.status === 'OPEN')?.groupNo ?? p.currentGroup ?? p.groups[0]?.groupNo ?? 1;
}

const TRANSITION_MS = 900;
/** 新标王特效显示时长：比普通提示略长，又不至于影响后续竞标 */
const CHAMPION_BURST_MS = 5500;

/** 新标王候选：金色爆炸光芒 + 粒子四散 + 大号文字 */
function ChampionBurst({ group, unit, pp }: { group: string; unit: string; pp: number | null }) {
  // 粒子方向与距离固定随机一次
  const sparks = useRef(
    Array.from({ length: 36 }, (_, i) => ({
      angle: (360 / 36) * i + (Math.random() * 8 - 4),
      dist: 380 + Math.random() * 360,
      size: 8 + Math.random() * 14,
      delay: Math.random() * 0.15,
      hue: Math.random() < 0.7 ? 'gold' : 'red',
    })),
  ).current;
  return (
    <div className="s-burst" aria-live="polite">
      <div className="s-burst-flash" />
      <div className="s-burst-rays" />
      <div className="s-burst-ring" />
      <div className="s-burst-ring r2" />
      {sparks.map((p, i) => (
        <span
          key={i}
          className={`s-spark ${p.hue}`}
          style={
            {
              '--a': `${p.angle}deg`,
              '--d': `${p.dist}px`,
              '--s': `${p.size}px`,
              animationDelay: `${0.25 + p.delay}s`,
            } as CSSProperties
          }
        />
      ))}
      <div className="s-burst-card">
        <div className="s-burst-kicker">{group} · 新标王候选</div>
        <div className="s-burst-unit">{unit}</div>
        {pp !== null && (
          <div className="s-burst-pp num">
            {pp}
            <span>%</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveScreen({ eventId, project }: { eventId: string; project: ProjectCode | null }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  // 新标王候选：大号居中 + 爆炸特效，约 5.5 秒后自动消失（不影响领导继续加码）
  const [burstInfo, setBurstInfo] = useState<{ id: number; group: string; unit: string; pp: number | null } | null>(null);
  useEffect(() => {
    if (!burstInfo) return;
    const t = setTimeout(() => setBurstInfo(null), CHAMPION_BURST_MS);
    return () => clearTimeout(t);
  }, [burstInfo?.id]);
  // 收到加码后等快照更新再决定播放哪种声音（是否出现新的标王候选）
  const pendingBid = useRef(false);
  const onMessage = (m: RealtimeMessage) => {
    if ((m.type === 'BID_ACCEPTED' || m.type === 'BID_CORRECTED') && m.unitCode) {
      setFlash((f) => ({ ...f, [m.unitCode!]: m.seq }));
      if (m.type === 'BID_ACCEPTED') pendingBid.current = true;
    }
  };
  const { data, conn, lastSyncAt } = useRealtime<LiveSnapshot>(`${base}/live${project ? `?project=${project}` : ''}`, `${base}/stream`, onMessage);
  const { tools, bidSound, championSound } = useScreenTools(eventId, soundOf(data?.event));

  // 组切换转场：旧组淡出左移，新组从右侧滑入
  const focusNo = data?.published ? focusGroupNo(data.project) : null;
  const [shown, setShown] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<number | null>(null);
  useEffect(() => {
    if (focusNo === null || focusNo === shown) return;
    if (shown !== null) {
      setLeaving(shown);
      const t = setTimeout(() => setLeaving(null), TRANSITION_MS);
      setShown(focusNo);
      return () => clearTimeout(t);
    }
    setShown(focusNo);
  }, [focusNo]);

  // 领先变化轻提示（只提示进行中的组）；出现新的标王候选时播放标王音效，否则播放普通加码音
  const prevTop = useRef<Record<number, string>>({});
  const prevChampion = useRef<Record<number, string>>({});
  useEffect(() => {
    if (!data?.published) return;
    let newChampion = false;
    for (const g of data.groups) {
      const key = g.topUnitCodes.join(',');
      const champ = g.leaderStatus === 'CHAMPION_CANDIDATE' ? key : '';
      const prev = prevTop.current[g.groupNo];
      const prevChamp = prevChampion.current[g.groupNo];
      const live = data.project.status === 'LIVE' && g.status === 'OPEN';
      const names = g.rows.filter((r) => g.topUnitCodes.includes(r.unitCode)).map((r) => r.unitName).join('、');
      if (prevChamp !== undefined && champ && champ !== prevChamp && live) {
        newChampion = true;
        setBurstInfo({ id: Date.now(), group: g.name, unit: names, pp: g.topPp });
      } else if (prev !== undefined && prev !== key && live && g.topUnitCodes.length) {
        setToast({ id: Date.now(), text: `${g.name}领先：${names} ${g.topPp}%` });
      }
      prevTop.current[g.groupNo] = key;
      prevChampion.current[g.groupNo] = champ;
    }
    if (pendingBid.current) {
      pendingBid.current = false;
      if (newChampion) championSound();
      else bidSound();
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
  const focus = data.groups.find((g) => g.groupNo === (shown ?? focusNo));
  const leavingGroup = leaving !== null ? data.groups.find((g) => g.groupNo === leaving) : undefined;
  const focusUnits = new Set(focus?.rows.map((r) => r.unitCode) ?? []);
  const feed = data.recentBids.filter((b) => focusUnits.has(b.unitCode));
  const sub = <>{focus && <span>{focus.name}</span>}</>;
  return (
    <Stage isDemo={data.event.isDemo}>
      <Head
        title={data.event.name || '现场竞标'}
        sub={sub}
        center={<span className={`s-project ${p.projectCode}`}>{PROJECT_NAMES[p.projectCode]}专场</span>}
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
      {burstInfo && <ChampionBurst key={burstInfo.id} group={burstInfo.group} unit={burstInfo.unit} pp={burstInfo.pp} />}
      {!data.published ? (
        <div className="s-center-msg">
          {PROJECT_NAMES[p.projectCode]}首轮结果待发布
          <small>请稍候</small>
        </div>
      ) : (
        <>
          <div className="s-progress">
            {p.groups.map((g) => (
              <span key={g.groupNo} className={`s-step ${g.groupNo === focus?.groupNo ? 'on' : ''} ${g.status === 'CLOSED' ? 'done' : ''}`}>
                {g.name}
                <small>{g.status === 'OPEN' ? '竞标中' : g.status === 'CLOSED' ? '已结束' : '待开始'}</small>
              </span>
            ))}
          </div>
          <div className="s-board-wrap">
            {leavingGroup && <FocusPanel key={`leave-${leavingGroup.groupNo}`} g={leavingGroup} flash={{}} className="leave" />}
            {focus && <FocusPanel key={`show-${focus.groupNo}`} g={focus} flash={flash} className={leaving !== null ? 'enter' : 'enter first'} />}
          </div>
        </>
      )}
      <div className="s-foot">
        <div className="s-feed-label">最新加码</div>
        <div className="s-feed">
          {feed.length === 0 && <span className="s-feed-item">暂无</span>}
          {feed.map((b) => (
            <span className="s-feed-item num" key={b.bidId}>
              {b.unitName} {b.fromPp}% → <b>{b.toPp}%</b>
              {b.source === 'ADMIN_CORRECTION' ? '（更正）' : ''}
            </span>
          ))}
        </div>
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}

/** 排名变化时行平滑移动到新位置（FLIP） */
function useRowMotion(order: string) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    refs.current.forEach((el, code) => {
      const top = el.offsetTop;
      next.set(code, top);
      const before = prev.current.get(code);
      if (before !== undefined && before !== top) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${before - top}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)';
          el.style.transform = '';
        });
      }
    });
    prev.current = next;
  }, [order]);
  return (code: string) => (el: HTMLDivElement | null) => {
    if (el) refs.current.set(code, el);
    else refs.current.delete(code);
  };
}

function FocusPanel({ g, flash, className }: { g: GroupBoard; flash: Record<string, number>; className: string }) {
  const closed = g.status === 'CLOSED';
  const waiting = g.status === 'WAITING';
  const withAmounts = g.rows.some((r) => r.targetWan !== undefined);
  const leaderNames = g.rows.filter((r) => g.topUnitCodes.includes(r.unitCode)).map((r) => r.unitName).join('、');
  const rowRef = useRowMotion(g.rows.map((r) => r.unitCode).join(','));
  let leaderText: ReactNode;
  if (g.leaderStatus === 'CHAMPION_CANDIDATE') leaderText = <span className="s-leader">{closed ? '本组标王' : '标王候选'}：{leaderNames}</span>;
  else if (g.leaderStatus === 'TIED_PENDING') leaderText = <span className="s-leader">并列领先·待确认：{leaderNames}</span>;
  else leaderText = <span className="s-leader none">暂无达到 30% 的标王候选</span>;
  return (
    <div className={`s-panel ${className} ${closed ? 'closed' : ''} ${g.status === 'OPEN' ? 'open' : ''} ${withAmounts ? 'amounts' : ''}`}>
      <div className="s-panel-head">
        <div className="s-panel-name">
          {g.name}
          <span className="s-panel-state">{g.status === 'OPEN' ? '竞标进行中' : closed ? '本组竞标结束 · 最终结果' : '即将开始'}</span>
        </div>
        <div className="s-panel-meta">
          <span>最低增幅 {g.minIncreasePp}% · 标王门槛 30%</span>
          {!waiting && leaderText}
        </div>
      </div>
      <div className="s-pcols">
        <span>排名</span>
        <span>单位</span>
        <span>首轮增幅</span>
        <span>当前增幅</span>
        {withAmounts && <span>竞标目标（万元）</span>}
      </div>
      <div className="s-prows">
        {g.rows.map((r) => {
          const badge =
            r.isTop && g.leaderStatus === 'CHAMPION_CANDIDATE' ? (
              <span className="s-badge">{closed ? '标王' : '标王候选'}</span>
            ) : r.isTop && g.leaderStatus === 'TIED_PENDING' ? (
              <span className="s-badge outline">并列领先</span>
            ) : r.isTop && g.leaderStatus === 'GROUP_LEADER' && g.topUnitCodes.length < g.rows.length ? (
              <span className="s-badge soft">{closed ? '本组第一' : LEADER_STATUS_LABELS.GROUP_LEADER}</span>
            ) : null;
          return (
            <div key={r.unitCode} ref={rowRef(r.unitCode)} className={`s-prow ${r.isTop && !waiting ? 'top' : ''}`}>
              {flash[r.unitCode] ? <span className="s-prow-flash" key={flash[r.unitCode]} /> : null}
              <span className="s-rank num">{r.rank}</span>
              <span className="s-unit">
                {r.unitName}
                {!waiting && badge}
              </span>
              <span className="s-first num">
                {r.firstRoundPp}
                <span className="pct">%</span>
              </span>
              <span className="s-current num">
                {r.currentPp}
                <span className="pct">%</span>
                {closed && r.currentPp > r.firstRoundPp && <span className="s-added up">+{r.currentPp - r.firstRoundPp}</span>}
              </span>
              {withAmounts && <span className="s-target num">{wan0(r.targetWan)}</span>}
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
  const { tools } = useScreenTools(eventId, { on: false });
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
        center={<span className={`s-project ${b.projectCode}`}>{PROJECT_NAMES[b.projectCode]}专场</span>}
        sub={<span>{PROJECT_NAMES[b.projectCode]} · 会前首轮结果</span>}
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
          首轮结果待发布
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
                    <span className="s-first num">{r.targetWan ? wan0(r.targetWan) : ''}</span>
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
      <div className="s-foot slim">
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}

// ------------------------------------------------------------------ 最终结果大屏

function ResultsScreen({ eventId }: { eventId: string }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const { tools } = useScreenTools(eventId, { on: false });
  const { data, conn, lastSyncAt } = useRealtime<ResultsSnapshot>(`${base}/results`, `${base}/stream`);
  if (!data) return <Stage>{null}</Stage>;
  return (
    <Stage isDemo={data.event.isDemo}>
      <Head
        title={data.event.name || '现场竞标'}
        sub={<span>理财、基金 · 各组最终结果</span>}
        center={<span className="s-project">现场竞标结果</span>}
        right={tools}
      />
      <OfflineAlert conn={conn} />
      <div className="s-results">
        {(['wealth', 'fund'] as ProjectCode[]).map((pc) => {
          const pr = data.projects[pc];
          return (
            <div className={`s-result-project ${pr.locked && pr.totals ? 'has-total' : ''}`} key={pc}>
              <div className="s-result-label">{pr.name}</div>
              {pr.locked && pr.totals && (
                <div className="s-total">
                  <span className="s-total-label">全市合计</span>
                  <span className="s-total-item">
                    基础底标<b className="num">{fenToYi2(pr.totals.baseFen)}</b>亿元
                  </span>
                  <span className="s-total-arrow">→</span>
                  <span className="s-total-item main">
                    最终竞标目标<b className="num">{fenToYi2(pr.totals.targetFen)}</b>亿元
                  </span>
                  <span className="s-total-item main">
                    全市增幅<b className="num">{increasePct2(pr.totals.baseFen, pr.totals.targetFen)}%</b>
                  </span>
                </div>
              )}
              {pr.locked ? (
                pr.groups.map((g) => (
                  <div className="s-result-group" key={g.groupNo}>
                    <h3>
                      {g.name}
                      <span className="s-badge soft">
                        {g.leaderStatus === 'CHAMPION_CANDIDATE' ? '现场标王' : g.leaderStatus === 'TIED_PENDING' ? '并列·待确认' : '未达30%门槛'}
                      </span>
                    </h3>
                    <div className={`s-result-row head ${g.rows[0]?.targetWan !== undefined ? 'with-target' : ''}`}>
                      <span />
                      <span>单位</span>
                      <span className="first">首轮</span>
                      <span className="added">加码</span>
                      <span className="final">最终</span>
                      {g.rows[0]?.targetWan !== undefined && <span className="target">目标（万元）</span>}
                    </div>
                    {g.rows.map((r) => (
                      <div className={`s-result-row ${r.isTop ? 'top' : ''} ${r.targetWan !== undefined ? 'with-target' : ''}`} key={r.unitCode}>
                        <span className="num">{r.rank}</span>
                        <span className="name">
                          {r.unitName}
                          {r.leaderLabel === '现场标王' && <span className="s-badge" style={{ marginLeft: 8 }}>标王</span>}
                        </span>
                        <span className="first num">{r.firstRoundPp}%</span>
                        <span className={`added num ${r.addedPp > 0 ? 'up' : ''}`}>{r.addedPp > 0 ? `+${r.addedPp}` : '—'}</span>
                        <span className="final num">{r.finalPp}%</span>
                        {r.targetWan !== undefined && <span className="target num">{wan0(r.targetWan)}</span>}
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
      <div className="s-foot slim">
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}

// ------------------------------------------------------------------ 标王颁奖大屏

function Trophy() {
  return (
    <svg className="s-award-trophy" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff1c4" />
          <stop offset="0.5" stopColor="#e2b85c" />
          <stop offset="1" stopColor="#a87a22" />
        </linearGradient>
      </defs>
      <path d="M18 8h28v10c0 9-6 16-14 16s-14-7-14-16V8z" fill="url(#tg)" />
      <path d="M18 12H9c0 8 4 13 11 14M46 12h9c0 8-4 13-11 14" fill="none" stroke="url(#tg)" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="28" y="33" width="8" height="10" fill="url(#tg)" />
      <rect x="20" y="43" width="24" height="6" rx="2" fill="url(#tg)" />
      <rect x="16" y="49" width="32" height="7" rx="2" fill="url(#tg)" />
      <path d="M32 13l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" fill="#fff8e6" opacity=".9" />
    </svg>
  );
}

function AwardsScreen({ eventId }: { eventId: string }) {
  const base = `/api/v1/screen/events/${eventId}`;
  const { data, conn, lastSyncAt } = useRealtime<ResultsSnapshot>(`${base}/results`, `${base}/stream`);
  const { tools, championSound } = useScreenTools(eventId, soundOf(data?.event));
  // 打开颁奖页时播放一次标王音效（需投屏电脑已点击过页面）
  const played = useRef(false);
  useEffect(() => {
    if (!data || played.current) return;
    played.current = true;
    setTimeout(() => championSound(), 600);
  }, [data]);
  // 彩带：位置与速度随机一次
  const confetti = useRef(
    Array.from({ length: 46 }, () => ({
      left: Math.random() * 100,
      delay: Math.random() * 6,
      dur: 6 + Math.random() * 6,
      size: 8 + Math.random() * 10,
      hue: Math.random() < 0.6 ? 'gold' : 'red',
    })),
  ).current;
  if (!data) return <Stage>{null}</Stage>;
  let order = 0;
  return (
    <Stage isDemo={data.event.isDemo}>
      <div className="s-confetti" aria-hidden="true">
        {confetti.map((c, i) => (
          <i
            key={i}
            className={c.hue}
            style={{ left: `${c.left}%`, width: c.size, height: c.size * 0.45, animationDelay: `${c.delay}s`, animationDuration: `${c.dur}s` }}
          />
        ))}
      </div>
      <Head
        title={data.event.name || '现场竞标'}
        sub={<span>理财、基金 · 各组标王</span>}
        center={<span className="s-project">标王荣誉榜</span>}
        right={tools}
      />
      <OfflineAlert conn={conn} />
      <div className="s-awards">
        {(['wealth', 'fund'] as ProjectCode[]).map((pc) => {
          const pr = data.projects[pc];
          return (
            <div className="s-award-row" key={pc}>
              <div className="s-result-label">{pr.name}</div>
              {[1, 2, 3].map((groupNo) => {
                const g = pr.groups.find((x) => x.groupNo === groupNo);
                const idx = order++;
                const style = { animationDelay: `${0.2 + idx * 0.25}s` };
                const groupName = g?.name ?? ['第一组', '第二组', '第三组'][groupNo - 1];
                if (!pr.locked || !g) {
                  return (
                    <div className="s-award-card pending" key={groupNo} style={style}>
                      <div className="s-award-group">
                        {pr.name} · {groupName}
                      </div>
                      <div className="s-award-wait">待锁定后揭晓</div>
                    </div>
                  );
                }
                const champs = g.rows.filter((r) => r.isTop);
                if (g.leaderStatus !== 'CHAMPION_CANDIDATE' && g.leaderStatus !== 'TIED_PENDING') {
                  return (
                    <div className="s-award-card none" key={groupNo} style={style}>
                      <div className="s-award-group">
                        {pr.name} · {groupName}
                      </div>
                      <div className="s-award-wait">本组暂无标王</div>
                      <div className="s-award-note">最高增幅未达 30% 门槛</div>
                    </div>
                  );
                }
                const tied = g.leaderStatus === 'TIED_PENDING';
                const top = champs[0];
                return (
                  <div className={`s-award-card ${tied ? 'tied' : ''}`} key={groupNo} style={style}>
                    <div className="s-award-shine" />
                    <Trophy />
                    <div className="s-award-group">
                      {pr.name} · {groupName}
                      {tied ? ' · 并列·待确认' : ' · 标王'}
                    </div>
                    <div className={`s-award-unit ${champs.length > 1 ? 'multi' : ''}`}>{champs.map((r) => r.unitName).join('、')}</div>
                    <div className="s-award-pp num">
                      {top.finalPp}
                      <span>%</span>
                    </div>
                    <div className="s-award-meta num">
                      {top.addedPp > 0 && <span>较首轮 +{top.addedPp}</span>}
                      {!tied && top.targetWan !== undefined && <span>竞标目标 {wan0(top.targetWan)} 万元</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="s-foot slim">
        <ConnInfo conn={conn} lastSyncAt={lastSyncAt} />
      </div>
    </Stage>
  );
}
