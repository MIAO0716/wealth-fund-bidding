import { type ReactNode, useEffect } from 'react';
import { CONN_LABEL, type ConnState } from '../lib/realtime';
import { fmtTime } from '../lib/format';

export function Modal(props: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">{props.title}</div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function DemoBadge({ show }: { show: boolean | undefined }) {
  return show ? <div className="demo-badge">演示</div> : null;
}

export function ConnLine({ conn, lastSyncAt }: { conn: ConnState; lastSyncAt: number | null }) {
  const cls = conn === 'live' ? 'live' : conn === 'connecting' ? '' : 'warn';
  return (
    <div className="m-conn">
      <span className={`dot ${cls}`} />
      {CONN_LABEL[conn]}
      {lastSyncAt && <span>· 最近同步 {fmtTime(new Date(lastSyncAt).toISOString())}</span>}
    </div>
  );
}

export function Pct({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v === null || v === undefined) return <span className={className}>—</span>;
  return (
    <span className={`num ${className ?? ''}`}>
      {v}
      <span className="pct">%</span>
    </span>
  );
}
