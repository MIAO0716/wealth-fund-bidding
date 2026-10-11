/**
 * 模拟金山文档：演练时代替真实金山表格，模拟领导在本单位表格中填写。
 * 只有「我要加到」（B6）一个格子可以填写，其余单元格只读，与正式表格的区域权限一致；格式（底色、字号）按脚本写入的显示。
 * 地址：/mock-kdocs?file=模拟文件ID[&sheet=单位名称]（带 sheet 时只显示该单位，模拟领导只能看到本单位）
 */

import { KDOCS_LAYOUT } from '@bidding/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';

type Cell = string | number | boolean | null;
interface CellStyle {
  fill?: string;
  color?: string;
  size?: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  wrap?: boolean;
}
interface Snapshot {
  fileId: string;
  sheets: Array<{ name: string; cells: Cell[][]; styles: Array<Array<CellStyle | null>>; colWidths: Array<number | null>; rowHeights: Array<number | null> }>;
}

const COLS = ['A', 'B'];

function cellCss(st: CellStyle | null): CSSProperties {
  if (!st) return {};
  return {
    background: st.fill ? `#${st.fill}` : undefined,
    color: st.color ? `#${st.color}` : undefined,
    // 表格字号按「磅」，网页上略放大
    fontSize: st.size ? Math.round(st.size * 1.15) : undefined,
    fontWeight: st.bold === undefined ? undefined : st.bold ? 700 : 400,
    textAlign: st.align,
    whiteSpace: st.wrap ? 'normal' : undefined,
  };
}

export function MockKdocsPage() {
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get('file') ?? '';
  const onlySheet = params.get('sheet');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(onlySheet);
  const editing = useRef(false);

  const load = () =>
    api
      .get<Snapshot>(`/api/v1/mock-kdocs/files/${encodeURIComponent(fileId)}`)
      .then((s) => {
        if (!editing.current) setSnap(s);
        setErr(null);
      })
      .catch((e) => setErr(errorText(e)));

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [fileId]);

  const setCell = async (sheet: string, addr: string, value: string) => {
    try {
      await api.put(`/api/v1/mock-kdocs/files/${encodeURIComponent(fileId)}/cell`, { sheet, cell: addr, value });
      await load();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  if (!fileId) return <div className="center-page muted">缺少模拟文件编号，请从管理端「金山文档」打开</div>;
  if (!snap) return <div className="center-page muted">{err ?? '加载中…'}</div>;

  const sheets = snap.sheets.filter((s) => s.name !== '使用说明' && (!onlySheet || s.name === onlySheet));
  const sheet = sheets.find((s) => s.name === active) ?? sheets[0];
  if (!sheet) return <div className="center-page muted">没有找到工作表{onlySheet ? `「${onlySheet}」` : ''}</div>;

  return (
    <div className="mk-page">
      <header className="mk-top">
        <span className="mk-logo">金山文档</span>
        <span className="mk-title">竞标填报表（模拟）</span>
        <span className="mk-badge">演练用 · 非正式金山文档</span>
      </header>
      {!onlySheet && (
        <nav className="mk-tabs">
          {sheets.map((s) => (
            <button key={s.name} className={`mk-tab ${s.name === sheet.name ? 'on' : ''}`} onClick={() => setActive(s.name)}>
              {s.name}
            </button>
          ))}
        </nav>
      )}
      {err && <div className="notice">{err}</div>}
      <div className="mk-scroll">
        <table className="mk-grid">
          <colgroup>
            <col className="mk-rh" />
            {/* 列宽按表格中的比例缩放到屏幕宽度（手机上与金山 App 一样不需要横向滑动） */}
            {COLS.map((c, i) => {
              const w = sheet.colWidths.map((x) => x ?? 12);
              return <col key={c} style={{ width: `${((w[i] / (w[0] + w[1])) * 100).toFixed(1)}%` }} />;
            })}
          </colgroup>
          <thead>
            <tr>
              <th className="mk-rh" />
              {COLS.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.cells.map((row, ri) => {
              const r = ri + 1;
              const h = sheet.rowHeights[ri];
              return (
                <tr key={r} style={{ height: h ? Math.round(h * 1.33) : undefined }}>
                  <td className="mk-rh">{r}</td>
                  {row.map((v, ci) => {
                    const c = ci + 1;
                    const addr = `${COLS[ci]}${r}`;
                    const text = v === null ? '' : String(v);
                    const css = cellCss(sheet.styles[ri]?.[ci] ?? null);
                    if (r === KDOCS_LAYOUT.inputRow && c === 2) {
                      return (
                        <td key={c} className="mk-edit mk-input" style={css}>
                          <input
                            key={`${sheet.name}-${addr}-${text}`}
                            defaultValue={text}
                            inputMode="numeric"
                            placeholder="填数字，如 40"
                            aria-label={`${sheet.name} 我要加到`}
                            style={{ color: css.color, fontSize: css.fontSize, fontWeight: css.fontWeight, textAlign: 'center' }}
                            onFocus={() => (editing.current = true)}
                            onBlur={(e) => {
                              editing.current = false;
                              if (e.target.value !== text) void setCell(sheet.name, addr, e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </td>
                      );
                    }
                    const tone = r === 7 && c === 2 ? (text.startsWith('✔') ? 'ok' : text.startsWith('✘') ? 'bad' : '') : '';
                    return (
                      <td key={c} className={`mk-ro ${tone}`} style={css}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mk-foot">只有黄色的「我要加到」可以填写；其余单元格由竞标程序写入，只读。页面每 1.5 秒自动刷新。</p>
    </div>
  );
}
