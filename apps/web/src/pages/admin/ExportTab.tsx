import { useEffect, useState } from 'react';
import { api, errorText } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import type { TabProps } from './EventPage';

interface Maintenance {
  backupEnabled: boolean;
  readOnly: boolean;
  logs: Array<{ id: number; action: string; details: Record<string, string>; createdAt: string }>;
}

const MAINT_LABEL: Record<string, string> = {
  CHECKPOINT: '已生成检查点',
  CHECKPOINT_FAILED: '检查点失败',
  RESTORE: '已从备份恢复',
};

export function ExportTab({ eventId, state }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}`;
  const [m, setM] = useState<Maintenance | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.get<Maintenance>('/api/v1/admin/maintenance').then(setM).catch(() => {});
  useEffect(() => {
    void load();
  }, [state.seq]);

  const allLocked = state.projects.wealth.status === 'LOCKED' && state.projects.fund.status === 'LOCKED';

  return (
    <>
      <div className="a-card">
        <h3>导出</h3>
        {allLocked ? (
          <div className="notice success" style={{ marginBottom: 12 }}>
            两个项目均已锁定，导出的最终竞标台账取自锁定快照，可用于公示与签字备案。
          </div>
        ) : (
          <div className="notice" style={{ marginBottom: 12 }}>
            仍有项目未锁定，导出文件将标注「过程数据」，不作为最终公示。
          </div>
        )}
        <div className="a-row">
          <a className="btn btn-primary" href={`${base}/exports/ledger.xlsx`}>
            导出 Excel（四个工作表）
          </a>
          <a className="btn" href={`${base}/exports/first-round.csv`}>
            首轮结果 CSV
          </a>
          <a className="btn" href={`${base}/exports/ledger.csv`}>
            最终竞标台账 CSV
          </a>
          <a className="btn" href={`${base}/exports/bids.csv`}>
            加码流水 CSV
          </a>
          <a className="btn" href={`${base}/exports/control.csv`}>
            确认与控制记录 CSV
          </a>
        </div>
        <p className="small muted">工作表：首轮结果、最终竞标台账、加码流水、确认与控制记录。百分比按 35% 格式显示，金额单位万元；不含任何凭证或会话信息。</p>
      </div>

      <div className="a-card">
        <h3>
          备份检查点
          <button
            className="btn btn-sm"
            disabled={!m?.backupEnabled}
            onClick={async () => {
              try {
                await api.post(`${base}/checkpoint`);
                setMsg({ ok: true, text: '已开始生成检查点，几秒后刷新查看结果' });
                setTimeout(() => void load(), 3000);
              } catch (e) {
                setMsg({ ok: false, text: errorText(e) });
              }
            }}
          >
            立即生成检查点
          </button>
        </h3>
        {msg && <div className={`notice ${msg.ok ? 'success' : ''}`}>{msg.text}</div>}
        {m && !m.backupEnabled && (
          <div className="notice">服务器未配置 BACKUP_DIR，不会自动备份。请在首轮发布后、项目锁定后按《部署说明》手动执行 scripts/backup.sh。</div>
        )}
        <p className="small muted">配置 BACKUP_DIR 后，系统会在每次首轮发布、项目锁定后自动生成检查点（pg_dump）。恢复须在停写状态下执行，见《部署说明》。</p>
        <table className="a-table">
          <tbody>
            {m?.logs.map((l) => (
              <tr key={l.id}>
                <td className="small">{fmtTime(l.createdAt, true)}</td>
                <td>
                  <span className={`chip ${l.action === 'CHECKPOINT_FAILED' ? 'red' : 'green'}`}>{MAINT_LABEL[l.action] ?? l.action}</span>
                </td>
                <td className="small">{l.details.label ?? ''}</td>
                <td className="small muted" style={{ wordBreak: 'break-all' }}>
                  {l.details.file ?? l.details.error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
