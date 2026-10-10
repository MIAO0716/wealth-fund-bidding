import { ERROR_MESSAGES, type ErrorCode } from '@bidding/shared';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import type { TabProps } from './EventPage';

interface Monitor {
  connections: Array<{ id: number; role: string; unitCode: string | null; connectedAt: string; lastSeq: number }>;
  screens: number;
  units: Array<{ unitCode: string; unitName: string; activeSessions: number; lastSeenAt: string | null }>;
  unitConnections: Record<string, number>;
  failures: Array<{ id: number; projectCode: string; unitCode: string; actorType: string; operation: string; errorCode: string; message: string; createdAt: string }>;
}
interface AuditLog {
  id: number;
  action: string;
  projectCode: string | null;
  unitCode: string | null;
  actorType: string;
  actorName: string;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  EVENT_CREATED: '创建活动',
  CONFIG_UPDATED: '修改配置',
  DRAFT_IMPORT_COMMIT: '导入首轮',
  DRAFT_MANUAL_EDIT: '手动录入首轮',
  FIRST_ROUND_PUBLISHED: '发布首轮',
  PROJECT_STARTED: '开始竞标',
  PROJECT_PAUSED: '暂停',
  PROJECT_RESUMED: '恢复',
  PROJECT_AUTO_PAUSED: '自动暂停',
  GROUP_OPENED: '开放组别',
  GROUP_REOPENED: '重新开放组别',
  GROUP_CLOSED: '结束组别',
  PROJECT_LOCKED: '锁定项目',
  BASE_ACK: '领导确认底标',
  BASE_ACK_PROXY: '代记底标确认',
  BID: '领导加码',
  BID_PROXY: '代录加码',
  CREDENTIAL_ISSUED: '发放二维码',
  UNIT_JOINED: '领导扫码进入',
  UNIT_SESSIONS_REVOKED: '撤销单位会话',
  SCREEN_KEY_CREATED: '生成大屏链接',
  SCREEN_KEY_REVOKED: '撤销大屏链接',
  SCREEN_MODE: '切换大屏',
  DEMO_SEEDED: '填充演示数据',
};

export function MonitorTab({ eventId, state }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}`;
  const [mon, setMon] = useState<Monitor | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    const load = () => api.get<Monitor>(`${base}/monitor`).then(setMon).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [base]);
  useEffect(() => {
    api.get<{ logs: AuditLog[] }>(`${base}/audit?limit=200`).then((r) => setLogs(r.logs)).catch(() => {});
  }, [base, state.seq]);

  return (
    <>
      <div className="a-grid">
        <div className="a-card">
          <h3>大屏连接</h3>
          <div className="stat">
            <b>{mon?.screens ?? '—'}</b>
            <span className="muted small">块大屏在线（SSE）</span>
          </div>
        </div>
        <div className="a-card">
          <h3>领导端在线</h3>
          <div className="stat">
            <b>{mon ? Object.values(mon.unitConnections).filter((n) => n > 0).length : '—'}/16</b>
            <span className="muted small">家单位有实时连接</span>
          </div>
        </div>
        <div className="a-card">
          <h3>提交失败</h3>
          <div className="stat">
            <b>{mon?.failures.length ?? '—'}</b>
            <span className="muted small">最近记录</span>
          </div>
        </div>
      </div>

      <div className="a-card">
        <h3>单位连接情况</h3>
        <div className="a-row">
          {mon?.units.map((u) => (
            <span key={u.unitCode} className={`chip ${mon.unitConnections[u.unitCode] ? 'green' : u.activeSessions ? 'gold' : 'grey'}`} title={`最近活跃 ${fmtTime(u.lastSeenAt)}`}>
              {u.unitName} {mon.unitConnections[u.unitCode] ? '在线' : u.activeSessions ? '已登录' : '未登录'}
            </span>
          ))}
        </div>
      </div>

      <div className="a-card">
        <h3>提交失败记录</h3>
        <table className="a-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>单位</th>
              <th>项目</th>
              <th>来源</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {mon?.failures.map((f) => (
              <tr key={f.id}>
                <td className="small">{fmtTime(f.createdAt)}</td>
                <td>{f.unitCode}</td>
                <td>{f.projectCode === 'wealth' ? '理财' : f.projectCode === 'fund' ? '基金' : ''}</td>
                <td>{f.actorType === 'ADMIN' ? '代录' : '领导'}</td>
                <td className="small">
                  {f.message || ERROR_MESSAGES[f.errorCode as ErrorCode]} <span className="muted">{f.errorCode}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="a-card">
        <h3>操作审计</h3>
        <div className="a-scroll">
          <table className="a-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>项目</th>
                <th>单位</th>
                <th>操作人</th>
                <th>原因 / 说明</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="small">{fmtTime(l.createdAt, true)}</td>
                  <td>{ACTION_LABEL[l.action] ?? l.action}</td>
                  <td>{l.projectCode === 'wealth' ? '理财' : l.projectCode === 'fund' ? '基金' : ''}</td>
                  <td>{l.unitCode ?? ''}</td>
                  <td>{l.actorName}</td>
                  <td className="small">
                    {l.reason}
                    {l.details?.fromPp !== undefined && ` ${l.details.fromPp}% → ${l.details.toPp}%`}
                    {typeof l.details?.groupNo === 'number' && ` 第${l.details.groupNo}组`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
