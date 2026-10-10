import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import type { TabProps } from './EventPage';

interface UnitAccess {
  unitCode: string;
  unitName: string;
  groupNo: number;
  credentialStatus: 'NONE' | 'ISSUED' | 'USED' | 'EXPIRED' | 'REVOKED';
  credentialIssuedAt: string | null;
  credentialExpiresAt: string | null;
  credentialUsedAt: string | null;
  activeSessions: number;
  lastSeenAt: string | null;
}
interface Issued {
  unitCode: string;
  unitName: string;
  joinUrl: string;
  qrDataUrl: string;
  expiresAt: string;
}

const CRED_LABEL: Record<UnitAccess['credentialStatus'], [string, string]> = {
  NONE: ['未发放', 'grey'],
  ISSUED: ['已发放待扫码', 'gold'],
  USED: ['已扫码', 'green'],
  EXPIRED: ['已过期', 'red'],
  REVOKED: ['已作废', 'grey'],
};

export function AccessTab({ eventId, state, me }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}`;
  const [units, setUnits] = useState<UnitAccess[] | null>(null);
  const [issued, setIssued] = useState<Issued[] | null>(null);
  const [keys, setKeys] = useState<Array<{ id: string; label: string; revokedAt: string | null; createdAt: string }>>([]);
  const [newKey, setNewKey] = useState<{ label: string; screenUrl: string; qrDataUrl: string } | null>(null);
  const [label, setLabel] = useState('主屏');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.get<{ units: UnitAccess[] }>(`${base}/units`).then((r) => setUnits(r.units)).catch(() => {});
    api.get<{ keys: typeof keys }>(`${base}/screen-keys`).then((r) => setKeys(r.keys)).catch(() => {});
  };
  useEffect(load, [state.seq]);

  const wrap = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
      load();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const issueOne = (u: UnitAccess, revokeSessions: boolean) =>
    wrap(async () => {
      if (u.credentialStatus !== 'NONE' && !window.confirm(`重新发放将作废${u.unitName}此前未使用的二维码${revokeSessions ? '，并让已登录的手机下线' : ''}，继续？`)) return;
      const r = await api.post<Issued>(`${base}/units/${u.unitCode}/credentials`, { revokeSessions });
      setIssued([r]);
    });

  const issueAll = () =>
    wrap(async () => {
      if (!window.confirm('将为 16 家单位重新生成二维码，此前未使用的二维码全部作废（已登录的手机不受影响）。继续？')) return;
      const r = await api.post<{ credentials: Issued[] }>(`${base}/credentials/batch`);
      setIssued(r.credentials);
    });

  const revoke = (u: UnitAccess) =>
    wrap(async () => {
      const reason = window.prompt(`撤销${u.unitName}的全部会话与未使用二维码，请填写原因：`);
      if (!reason) return;
      await api.post(`${base}/units/${u.unitCode}/revoke`, { reason });
      setMsg({ ok: true, text: `${u.unitName}会话已撤销，请重新发放二维码` });
    });

  return (
    <>
      {msg && (
        <div className={`notice ${msg.ok ? 'success' : ''}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}
      <div className="a-card">
        <h3>
          领导专属二维码
          <button className="btn btn-primary" onClick={() => void issueAll()} disabled={busy}>
            批量生成 16 家二维码（打印）
          </button>
        </h3>
        <p className="small muted">
          二维码地址：{me.publicBaseUrl}/join#…（由服务器配置 PUBLIC_BASE_URL 决定，手机必须能访问该地址；不能是 localhost）。同一二维码理财、基金通用；一次性使用，扫码后绑定该手机。
          凭证只在生成时显示一次，请当场打印或发送。
        </p>
        {!units ? (
          <p className="muted">加载中…</p>
        ) : (
          <table className="a-table">
            <thead>
              <tr>
                <th>组别</th>
                <th>单位</th>
                <th>二维码</th>
                <th>发放时间</th>
                <th>有效期至</th>
                <th>在线会话</th>
                <th>最近活跃</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.unitCode}>
                  <td>第{u.groupNo}组</td>
                  <td>{u.unitName}</td>
                  <td>
                    <span className={`chip ${CRED_LABEL[u.credentialStatus][1]}`}>{CRED_LABEL[u.credentialStatus][0]}</span>
                  </td>
                  <td className="small">{fmtTime(u.credentialIssuedAt, true)}</td>
                  <td className="small">{fmtTime(u.credentialExpiresAt, true)}</td>
                  <td>{u.activeSessions > 0 ? <span className="chip green">{u.activeSessions}</span> : <span className="chip grey">0</span>}</td>
                  <td className="small">{fmtTime(u.lastSeenAt)}</td>
                  <td className="r">
                    <div className="a-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <button className="btn btn-sm" disabled={busy} onClick={() => void issueOne(u, false)}>
                        {u.credentialStatus === 'NONE' ? '发放' : '重发'}
                      </button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => void issueOne(u, true)} title="重发并让已登录手机下线">
                        换手机
                      </button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => void revoke(u)}>
                        撤销
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="a-card">
        <h3>大屏只读链接</h3>
        <div className="a-row">
          <label className="field">
            <span>名称</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button
            className="btn btn-primary"
            style={{ alignSelf: 'flex-end' }}
            disabled={busy}
            onClick={() =>
              void wrap(async () => {
                setNewKey(await api.post(`${base}/screen-keys`, { label }));
              })
            }
          >
            生成大屏链接
          </button>
        </div>
        <p className="small muted">
          在投屏电脑上打开链接即可，页面会自动跟随管理端的「大屏展示」切换。打开后也可直接访问 /screen/first-round、/screen/live、/screen/results（可加 ?project=wealth 或 fund）。
        </p>
        <table className="a-table">
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td className="small">{fmtTime(k.createdAt, true)}</td>
                <td>{k.revokedAt ? <span className="chip grey">已撤销</span> : <span className="chip green">有效</span>}</td>
                <td className="r">
                  {!k.revokedAt && (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        void wrap(async () => {
                          if (!window.confirm(`撤销「${k.label}」后，使用该链接的大屏将无法继续显示。继续？`)) return;
                          await api.post(`${base}/screen-keys/${k.id}/revoke`);
                        })
                      }
                    >
                      撤销
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {issued && (
        <Modal
          wide
          title={`领导二维码（${issued.length} 家）`}
          onClose={() => setIssued(null)}
          footer={
            <>
              <button className="btn no-print" onClick={() => setIssued(null)}>
                关闭（凭证不再显示）
              </button>
              <button className="btn btn-primary no-print" onClick={() => window.print()}>
                打印
              </button>
            </>
          }
        >
          <p className="small muted no-print">二维码一次性使用，请勿外传或投屏。有效期至 {fmtTime(issued[0]?.expiresAt, true)}。</p>
          <div className="qr-grid" style={{ gridTemplateColumns: issued.length === 1 ? '1fr' : undefined }}>
            {issued.map((c) => (
              <div className="qr-card" key={c.unitCode}>
                <b style={{ fontSize: 18 }}>{c.unitName}</b>
                <div className="small muted">
                  {state.event.config.name} · {c.unitCode}
                </div>
                <img src={c.qrDataUrl} alt={`${c.unitName}二维码`} />
                {issued.length === 1 && <div className="small" style={{ wordBreak: 'break-all' }}>{c.joinUrl}</div>}
              </div>
            ))}
          </div>
        </Modal>
      )}
      {newKey && (
        <Modal title={`大屏链接：${newKey.label}`} onClose={() => setNewKey(null)} footer={<button className="btn" onClick={() => setNewKey(null)}>关闭（链接不再显示）</button>}>
          <div style={{ textAlign: 'center' }}>
            <img src={newKey.qrDataUrl} alt="大屏链接" style={{ width: 220 }} />
          </div>
          <div className="small" style={{ wordBreak: 'break-all', userSelect: 'all', background: '#faf6f2', padding: 10, borderRadius: 8 }}>
            {newKey.screenUrl}
          </div>
          <p className="small muted">复制链接到投屏电脑的浏览器打开。</p>
        </Modal>
      )}
    </>
  );
}
