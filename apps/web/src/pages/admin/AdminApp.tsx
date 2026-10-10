import type { EventSummary } from '@bidding/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, api, errorText } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { EventPage } from './EventPage';

export interface AdminInfo {
  admin: { id: string; displayName: string };
  readOnly: boolean;
  publicBaseUrl: string;
}

export function AdminApp() {
  const [me, setMe] = useState<AdminInfo | null>(null);
  const [checking, setChecking] = useState(true);

  const load = () =>
    api
      .get<AdminInfo>('/api/v1/auth/admin/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));

  useEffect(() => {
    void load();
  }, []);

  if (checking) return <div className="center-page muted">加载中…</div>;
  if (!me) return <Login onDone={load} />;

  const logout = async () => {
    await api.post('/api/v1/auth/admin/logout').catch(() => {});
    setMe(null);
  };

  return (
    <div className="a-shell">
      <header className="a-top no-print">
        <Link to="/admin" className="brand" style={{ textDecoration: 'none' }}>
          现场竞标 <span>管理端</span>
        </Link>
        <div className="who">
          {me.readOnly && <span className="chip gold">只读维护模式</span>}
          <span>{me.admin.displayName}</span>
          <button className="btn btn-sm btn-ghost" style={{ borderColor: 'rgba(255,255,255,.4)' }} onClick={() => void logout()}>
            退出
          </button>
        </div>
      </header>
      <main className="a-main">
        <Routes>
          <Route index element={<EventList />} />
          <Route path="events/:eventId/*" element={<EventPage me={me} />} />
        </Routes>
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/v1/auth/admin/login', { username, password });
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>现场竞标 · 工作人员登录</h1>
        <label className="field">
          <span>账号</span>
          <input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        </label>
        {err && <div className="notice">{err}</div>}
        <button className="btn btn-primary" style={{ minHeight: 46 }} disabled={busy || !username || !password}>
          登录
        </button>
      </form>
    </div>
  );
}

function EventList() {
  const nav = useNavigate();
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<{ events: EventSummary[] }>('/api/v1/admin/events')
      .then((r) => setEvents(r.events))
      .catch((e) => setErr(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  const create = async (isDemo: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ event: EventSummary }>('/api/v1/admin/events', isDemo ? { isDemo: true } : { config: { name } });
      nav(`/admin/events/${r.event.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="a-card">
        <h3>新建活动</h3>
        <div className="a-row">
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            <span>正式活动名称（日期、口径等可在活动内配置）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：2026年理财、基金现场竞标" />
          </label>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create(false)} style={{ alignSelf: 'flex-end' }}>
            新建正式活动
          </button>
          <button className="btn" disabled={busy} onClick={() => void create(true)} style={{ alignSelf: 'flex-end' }}>
            新建演示活动
          </button>
        </div>
        <p className="small muted">正式活动的底标和首轮初始为「未填写 / 未录入」，不会生成任何数值；演示活动自动填入演示数据，所有页面标注「演示」。</p>
        {err && <div className="notice">{err}</div>}
      </div>
      <div className="a-card">
        <h3>活动列表</h3>
        {!events ? (
          <p className="muted">加载中…</p>
        ) : events.length === 0 ? (
          <p className="muted">暂无活动</p>
        ) : (
          <table className="a-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>活动日期</th>
                <th>当前专场</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <b>{e.config.name || '（未命名）'}</b>
                    {e.parentEventId && <div className="small muted">关联原活动重新创建：{e.parentReason}</div>}
                  </td>
                  <td>{e.isDemo ? <span className="chip grey">演示</span> : <span className="chip red">正式</span>}</td>
                  <td>{e.config.eventDate ?? '—'}</td>
                  <td>{e.currentProject === 'wealth' ? '理财' : '基金'}</td>
                  <td>{fmtTime(e.createdAt, true)}</td>
                  <td className="r">
                    <Link className="btn btn-sm" to={`/admin/events/${e.id}`}>
                      进入
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
