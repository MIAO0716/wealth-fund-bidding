import { useEffect, useState } from 'react';
import { type CardCredential, type CardInfo, LeaderCard, PrintCards } from '../../components/LeaderCards';
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
  /** 当前有实时连接（或刚断开不到 1 分钟） */
  online?: boolean;
}
interface Issued {
  creds: CardCredential[];
  card: CardInfo;
}

const CRED_LABEL: Record<UnitAccess['credentialStatus'], [string, string]> = {
  NONE: ['未生成', 'grey'],
  ISSUED: ['已生成，未扫码', 'gold'],
  USED: ['已扫码', 'green'],
  EXPIRED: ['已过期', 'red'],
  REVOKED: ['已作废', 'grey'],
};

export function AccessTab({ eventId, state, me }: TabProps) {
  const base = `/api/v1/admin/events/${eventId}`;
  const [units, setUnits] = useState<UnitAccess[] | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
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

  // 二维码活动期间固定不变：再次打开显示的是同一个二维码
  const showOne = (u: UnitAccess) =>
    wrap(async () => {
      const r = await api.post<CardCredential & { card: CardInfo }>(`${base}/units/${u.unitCode}/credentials`, {});
      setIssued({ creds: [r], card: r.card });
    });

  const showAll = () =>
    wrap(async () => {
      const r = await api.post<{ credentials: CardCredential[]; card: CardInfo }>(`${base}/credentials/batch`);
      setIssued({ creds: r.credentials, card: r.card });
    });

  const kick = (u: UnitAccess) =>
    wrap(async () => {
      if (!window.confirm(`让${u.unitName}当前登录的手机下线？\n二维码继续有效，领导用任一手机重新扫码即可继续。`)) return;
      await api.post(`${base}/units/${u.unitCode}/kick`);
      setMsg({ ok: true, text: `${u.unitName}的手机已强制下线，领导重新扫码即可继续` });
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
          <button className="btn btn-primary" onClick={() => void showAll()} disabled={busy}>
            16 家领导使用卡（生成 / 打印）
          </button>
        </h3>
        <p className="small muted">
          二维码地址：{me.publicBaseUrl}/join#…（由服务器配置 PUBLIC_BASE_URL 决定，手机必须能访问该地址；不能是 localhost）。<b>每家单位一个固定二维码，活动期间不变</b>，理财、基金通用，可随时再次显示、补打印；领导用任何手机扫同一个码都能登录，同一时间只有一部手机在线（新手机登录后旧手机自动下线）。需要让某部手机下线时点「强制下线」，领导再扫原来的码即可重新登录。
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
                <th>生成时间</th>
                <th>有效期至</th>
                <th>在线手机</th>
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
                  <td>
                    {u.online ? (
                      <span className="chip green">在线</span>
                    ) : u.activeSessions > 0 ? (
                      <span className="chip">已登录·暂离</span>
                    ) : (
                      <span className="chip grey">未登录</span>
                    )}
                  </td>
                  <td className="small">{fmtTime(u.lastSeenAt)}</td>
                  <td className="r">
                    <div className="a-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <button className="btn btn-sm" disabled={busy} onClick={() => void showOne(u)} title="显示该单位的使用卡（同一个二维码），可让领导直接扫电脑屏幕">
                        {u.credentialStatus === 'NONE' ? '生成' : '显示二维码'}
                      </button>
                      <button className="btn btn-sm" disabled={busy || u.activeSessions === 0} onClick={() => void kick(u)} title="让当前手机下线，二维码继续有效">
                        强制下线
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
          title={issued.creds.length === 1 ? `领导使用卡：${issued.creds[0].unitName}（可直接让领导扫屏幕上的二维码）` : `领导使用卡（${issued.creds.length} 家，每页 A4 一个单位）`}
          onClose={() => setIssued(null)}
          footer={
            <>
              <button className="btn" onClick={() => setIssued(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => window.print()}>
                打印
              </button>
            </>
          }
        >
          <p className="small muted">
            二维码活动期间固定不变（有效期至 {fmtTime(issued.creds[0]?.expiresAt, true)}），可随时再次打开补打印；同一时间只有一部手机在线。请勿投屏或外传。
            {!issued.card.wifi && ' 如需在卡上印「扫码连 Wi-Fi」，请先在「准备与配置」填写会场 Wi-Fi。'}
          </p>
          <div className="card-grid">
            {issued.creds.map((c) => (
              <LeaderCard key={c.unitCode} c={c} card={issued.card} />
            ))}
          </div>
          <PrintCards creds={issued.creds} card={issued.card} />
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
