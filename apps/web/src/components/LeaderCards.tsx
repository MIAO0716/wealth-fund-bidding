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
            <b>用手机自带「相机」扫右侧二维码进入（推荐）</b>
            <span>扫码后自动登录{c.unitName}，无需账号密码。相机扫不出时可用微信「扫一扫」，提示时点「继续访问」。</span>
            <span>换手机直接用新手机扫码即可，旧手机自动下线（同一时间一部手机在线）。请勿转发。</span>
          </div>
          <img className="lc-qr lc-qr-main" src={c.qrDataUrl} alt={`${c.unitName}二维码`} />
        </div>
        <div className="lc-step">
          <div className="lc-num">{++n}</div>
          <div className="lc-text">
            <b>点「确认认领基础底标」；轮到本组时选择追加幅度（整数），点「追加」并确认</b>
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

export interface KdocsCardItem {
  unitCode: string;
  unitName: string;
  url: string;
  qrDataUrl: string;
}

/** 金山文档扫码填报卡：二维码即本单位的金山表格链接，微信扫一扫直接打开（各单位只能看到自己的表） */
export function KdocsCard({ c, card }: { c: KdocsCardItem; card: CardInfo }) {
  const unit = UNIT_BY_CODE.get(c.unitCode);
  const group = GROUPS.find((g) => g.groupNo === unit?.groupNo);
  let n = 0;
  return (
    <div className="leader-card">
      <div className="lc-head">
        <div className="lc-event">{card.eventName || '现场竞标'}</div>
        <div className="lc-unit">
          {c.unitName}
          <small>{group?.name} · 金山文档填报</small>
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
              <span>用自己的流量也可以，已连接可跳过。</span>
            </div>
            <img className="lc-qr" src={card.wifi.qrDataUrl} alt="Wi-Fi 二维码" />
          </div>
        )}
        <div className="lc-step lc-main">
          <div className="lc-num">{++n}</div>
          <div className="lc-text">
            <b>微信「扫一扫」，打开{c.unitName}的竞标填报表</b>
            <span>只有{c.unitName}的表，其他单位看不到。</span>
            <span>首次打开如提示登录，用微信登录即可。</span>
          </div>
          <img className="lc-qr lc-qr-main" src={c.qrDataUrl} alt={`${c.unitName}填报表二维码`} />
        </div>
        <div className="lc-step">
          <div className="lc-num">{++n}</div>
          <div className="lc-text">
            <b>轮到本组时，在黄色「我要加到」格子填一个数字（如 40），告诉工作人员</b>
            <span>「处理结果」显示「✔ 已生效」即完成；第一次填写即确认本专场底标。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PrintKdocsCards({ cards, card }: { cards: KdocsCardItem[]; card: CardInfo }) {
  return createPortal(
    <div className="print-only">
      {cards.map((c) => (
        <KdocsCard key={c.unitCode} c={c} card={card} />
      ))}
    </div>,
    document.body,
  );
}
