import { GROUPS, UNIT_BY_CODE } from '@bidding/shared';
import { createPortal } from 'react-dom';
import { wan0, wan2 } from '../lib/format';

export interface CardFirstRound {
  baseTargetWan: string | null;
  firstRoundPp: number | null;
  targetWan: string | null;
  frozen: boolean;
}

export interface CardCredential {
  unitCode: string;
  unitName: string;
  joinUrl: string;
  qrDataUrl: string;
  expiresAt: string;
  /** 该单位会前首轮数据（理财、基金） */
  firstRound?: Partial<Record<'wealth' | 'fund', CardFirstRound>>;
}

export interface CardInfo {
  eventName: string;
  wifi: { ssid: string; password: string; qrDataUrl: string } | null;
}

function FirstRoundTile({ name, d }: { name: string; d?: CardFirstRound }) {
  return (
    <div className="lp-tile">
      <div className="lp-tile-name">{name}</div>
      <div className="lp-kv">
        <span>基础底标</span>
        <b className="num">{d?.baseTargetWan ? wan2(d.baseTargetWan) : '待录入'}</b>
        <em>万元</em>
      </div>
      <div className="lp-kv big">
        <span>首轮增幅</span>
        <b className="num">{d?.firstRoundPp !== null && d?.firstRoundPp !== undefined ? `${d.firstRoundPp}%` : '待录入'}</b>
      </div>
      <div className="lp-kv">
        <span>首轮目标</span>
        <b className="num">{d?.targetWan ? wan0(d.targetWan) : '—'}</b>
        <em>万元</em>
      </div>
    </div>
  );
}

/**
 * 领导使用卡：每页一个单位（A4 纵向）。
 * 上半部分：该单位会前导入的基础底标与首轮增幅（理财、基金）；下半部分：专属二维码与使用说明。
 */
export function LeaderCard({ c, card }: { c: CardCredential; card: CardInfo }) {
  const unit = UNIT_BY_CODE.get(c.unitCode);
  const group = GROUPS.find((g) => g.groupNo === unit?.groupNo);
  const frozen = !!(c.firstRound?.wealth?.frozen && c.firstRound?.fund?.frozen);
  return (
    <div className="leader-card leader-page">
      <div className="lp-head">
        <div className="lp-event">{card.eventName || '现场竞标'}</div>
        <div className="lp-unit">{c.unitName}</div>
        <div className="lp-group">
          {group?.name} · 领导专用 · 本组最低增幅 {group?.minIncreasePp ?? 10}% · 标王门槛 30%
        </div>
      </div>

      <div className="lp-top">
        <div className="lp-section-title">
          会前首轮数据<small>{frozen ? '（已冻结，现场从首轮起加码）' : '（草稿，冻结后以系统为准）'}</small>
        </div>
        <div className="lp-tiles">
          <FirstRoundTile name="理财" d={c.firstRound?.wealth} />
          <FirstRoundTile name="基金" d={c.firstRound?.fund} />
        </div>
      </div>

      <div className="lp-cut" />

      <div className="lp-bottom">
        <div className="lp-qr-box">
          <img className="lc-qr-main" src={c.qrDataUrl} alt={`${c.unitName}二维码`} />
          <div className="lp-qr-cap">{c.unitName} · 扫码进入</div>
        </div>
        <div className="lp-steps">
          <div className="lp-section-title">使用说明</div>
          <ol>
            {card.wifi && (
              <li>
                <b>连接会场 Wi-Fi</b>：{card.wifi.ssid}
                {card.wifi.password ? `，密码 ${card.wifi.password}` : '（无密码）'}
                <img className="lp-wifi" src={card.wifi.qrDataUrl} alt="Wi-Fi 二维码" />
              </li>
            )}
            <li>
              <b>用手机自带「相机」扫左侧二维码</b>，自动进入{c.unitName}页面，无需账号密码。相机扫不出时可用微信「扫一扫」，提示时点「继续访问」。
            </li>
            <li>
              <b>点「确认认领基础底标」</b>，理财、基金各一次（页面顶部可切换）。
            </li>
            <li>
              <b>轮到本组时</b>选择追加幅度（整数个百分点），点「确认追加」并「确认提交」，看到「追加成功 · 服务器已确认」即完成。
            </li>
          </ol>
          <p className="lp-note">二维码活动期间不变；换手机直接用新手机扫码，旧手机自动下线。请妥善保管，勿转发。遇到问题请举手示意工作人员。</p>
        </div>
      </div>
    </div>
  );
}

/** 打印专用区域：只在打印时显示，屏幕上不占位；每页一个单位 */
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
