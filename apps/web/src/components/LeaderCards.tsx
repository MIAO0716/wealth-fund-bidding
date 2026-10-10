import { GROUPS, UNIT_BY_CODE } from '@bidding/shared';
import { createPortal } from 'react-dom';

export interface CardCredential {
  unitCode: string;
  unitName: string;
  joinUrl: string;
  qrDataUrl: string;
  expiresAt: string;
}

export interface CardInfo {
  eventName: string;
  wifi: { ssid: string; password: string; qrDataUrl: string } | null;
}

/** 领导使用卡：Wi-Fi 二维码（可选）+ 单位专属二维码 + 三步说明。每张 A4 打印两张。 */
export function LeaderCard({ c, card }: { c: CardCredential; card: CardInfo }) {
  const unit = UNIT_BY_CODE.get(c.unitCode);
  const group = GROUPS.find((g) => g.groupNo === unit?.groupNo);
  let n = 0;
  return (
    <div className="leader-card">
      <div className="lc-head">
        <div className="lc-event">{card.eventName || '现场竞标'}</div>
        <div className="lc-unit">
          {c.unitName}
          <small>{group?.name} · 领导专用</small>
        </div>
      </div>
      <div className="lc-body">
        {card.wifi && (
          <div className="lc-step">
            <div className="lc-num">{++n}</div>
            <div className="lc-text">
              <b>用手机自带「相机」扫码，连接会场 Wi-Fi</b>
              <span>
                Wi-Fi：{card.wifi.ssid}
                {card.wifi.password ? `　密码：${card.wifi.password}` : '（无密码）'}
              </span>
              <span>已连接可跳过。iPhone 扫码后点「加入网络」。</span>
            </div>
            <img className="lc-qr" src={card.wifi.qrDataUrl} alt="Wi-Fi 二维码" />
          </div>
        )}
        <div className="lc-step lc-main">
          <div className="lc-num">{++n}</div>
          <div className="lc-text">
            <b>打开微信「扫一扫」，扫右侧二维码进入</b>
            <span>扫码后自动登录{c.unitName}，无需账号密码。</span>
            <span>二维码只能在一部手机上使用，请勿转发。</span>
          </div>
          <img className="lc-qr lc-qr-main" src={c.qrDataUrl} alt={`${c.unitName}二维码`} />
        </div>
        <div className="lc-step">
          <div className="lc-num">{++n}</div>
          <div className="lc-text">
            <b>点「确认认领基础底标」；轮到本组时选择档位，点「追加」并确认</b>
            <span>看到「追加成功 · 服务器已确认」即完成。遇到问题请举手示意工作人员。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 打印专用区域：只在打印时显示，屏幕上不占位 */
export function PrintCards({ creds, card }: { creds: CardCredential[]; card: CardInfo }) {
  return createPortal(
    <div className="print-only">
      {creds.map((c) => (
        <LeaderCard key={c.unitCode} c={c} card={card} />
      ))}
    </div>,
    document.body,
  );
}
