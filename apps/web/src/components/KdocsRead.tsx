/**
 * 「读取金山表格」按钮：金山文档默认手动读取，工作人员看到表格有变化时点一下，读取一次并处理。
 * 用于「现场控制」与「金山文档」页面；未启用金山文档时不显示。
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { fmtTime } from '../lib/format';

export interface KdocsReadSummary {
  at: string;
  applied: number;
  rejected: number;
  acked: number;
  units: string[];
  durationMs: number;
}

interface Brief {
  binding: { enabled: boolean; autoSync: boolean; isMock: boolean } | null;
  status: { state: string; lastError: string | null; lastRead: KdocsReadSummary | null; calls: number } | null;
}

export function readSummaryText(r: KdocsReadSummary | null | undefined): string {
  if (!r) return '尚未读取';
  const parts: string[] = [];
  if (r.applied) parts.push(`新生效 ${r.applied} 条`);
  if (r.rejected) parts.push(`未生效 ${r.rejected} 条`);
  if (r.acked) parts.push(`认领底标 ${r.acked} 家`);
  const what = parts.length ? `${parts.join('、')}${r.units.length ? `（${r.units.join('、')}）` : ''}` : '没有新的填写';
  return `${fmtTime(r.at)} 读取：${what}`;
}

export function KdocsReadBar({ eventId, compact = false, onRead }: { eventId: string; compact?: boolean; onRead?: () => void }) {
  const base = `/api/v1/admin/events/${eventId}/kdocs`;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    api
      .get<Brief>(base)
      .then(setBrief)
      .catch(() => {});

  useEffect(() => {
    void load();
    // 只查询本机状态，不会调用金山文档
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [eventId]);

  if (!brief) return null;
  if (!brief.binding?.enabled) {
    // 尚未连接 / 已停用：在同一位置提示去哪里连接（只用手机扫码竞标时可忽略）
    if (!compact) return null;
    return (
      <div className="kd-read off">
        <button className="btn" disabled title="连接金山文档后可用">
          读取金山表格
        </button>
        <div className="kd-read-info">
          <span className="muted">
            {brief.binding ? '金山文档读取已停用。' : '尚未连接金山文档。'}
            如需让领导在金山文档中填写，请到
            <Link to={`/admin/events/${eventId}/kdocs`}>「金山文档」页</Link>
            {brief.binding ? '启用读取' : '一键连接'}；只用手机扫码竞标可忽略。
          </span>
        </div>
      </div>
    );
  }
  const st = brief.status;

  const read = async () => {
    setBusy(true);
    setErr(null);
    try {
      const o = await api.post<Brief>(`${base}/sync-now`, {}, { timeoutMs: 60_000 });
      setBrief(o);
      onRead?.();
    } catch (e) {
      setErr(errorText(e));
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`kd-read ${compact ? 'compact' : ''}`}>
      <button className="btn btn-primary" disabled={busy} onClick={() => void read()}>
        {busy ? '读取中…' : '读取金山表格'}
      </button>
      <div className="kd-read-info">
        <span>{readSummaryText(st?.lastRead)}</span>
        {(err || st?.state === 'ERROR') && <span className="err-text">读取失败：{err ?? st?.lastError}</span>}
        {!compact && (
          <span className="small muted">
            {brief.binding.autoSync ? '已开启自动定时读取' : '手动读取：领导说填好了，点一下即可'}
            {brief.binding.isMock ? '（模拟金山文档）' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
