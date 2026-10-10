import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText, takeHashParam } from '../lib/api';

/** 扫码入口：一次性凭证换取单位会话，成功后从地址栏移除凭证并进入竞标页 */
export function JoinPage() {
  const nav = useNavigate();
  const [msg, setMsg] = useState('正在验证二维码…');
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeHashParam('t');
    if (!token) {
      // 已有会话时直接进入
      api
        .get('/api/v1/bidder/session')
        .then(() => nav('/bid', { replace: true }))
        .catch(() => {
          setFailed(true);
          setMsg('请使用工作人员发放的专属二维码进入');
        });
      return;
    }
    api
      .post('/api/v1/auth/bidder/exchange', { token })
      .then(() => nav('/bid', { replace: true }))
      .catch(async (e) => {
        // 凭证已用过但本机已有会话（如重复扫码），直接进入
        try {
          await api.get('/api/v1/bidder/session');
          nav('/bid', { replace: true });
        } catch {
          setFailed(true);
          setMsg(errorText(e));
        }
      });
  }, [nav]);

  return (
    <div className="center-page">
      <div className="center-card">
        <h2>{failed ? '无法进入' : '现场竞标'}</h2>
        <p className={failed ? '' : 'muted'}>{msg}</p>
        {failed && <p className="muted small">如需帮助，请联系现场工作人员重新发放二维码。</p>}
      </div>
    </div>
  );
}
