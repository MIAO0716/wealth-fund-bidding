/**
 * 模拟金山文档：演练时代替真实金山表格，模拟领导在本单位工作表中填写。
 * 只有领导可编辑的单元格（B11、报价行 B/C 列）可以修改，其余单元格只读，与正式表格的权限设置一致。
 * 地址：/mock-kdocs?file=模拟文件ID[&sheet=单位名称]（带 sheet 时只显示该单位，模拟领导只能看到本单位）
 */

import { KDOCS_LAYOUT, bidRowRange } from '@bidding/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';

type Cell = string | number | boolean | null;
interface Snapshot {
  fileId: string;
  maxRows: number;
  sheets: Array<{ name: string; cells: Cell[][] }>;
}

const COLS = ['A', 'B', 'C', 'D', 'E'];
const TARGET_OPTIONS = Array.from({ length: 24 }, (_, i) => String((i + 1) * 5));

function editable(row: number, col: number, maxRows: number): 'ack' | 'target' | 'confirm' | null {
  const { first, last } = bidRowRange(maxRows);
  if (row === KDOCS_LAYOUT.ackRow && col === 2) return 'ack';
  if (row >= first && row <= last && col === 2) return 'target';
  if (row >= first && row <= last && col === 3) return 'confirm';
  return null;
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
              const header = r === 1 || r === KDOCS_LAYOUT.headerRow;
              return (
                <tr key={r} className={header ? 'mk-head' : r === KDOCS_LAYOUT.ackRow ? 'mk-ack' : ''}>
                  <td className="mk-rh">{r}</td>
                  {row.map((v, ci) => {
                    const c = ci + 1;
                    const addr = `${COLS[ci]}${r}`;
                    const kind = editable(r, c, snap.maxRows);
                    const text = v === null ? '' : String(v);
                    if (kind === 'target') {
                      return (
                        <td key={c} className="mk-edit">
                          <input
                            key={`${sheet.name}-${addr}-${text}`}
                            defaultValue={text}
                            inputMode="numeric"
                            list="mk-targets"
                            aria-label={`${sheet.name} ${addr}`}
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
                    if (kind === 'ack' || kind === 'confirm') {
                      return (
                        <td key={c} className="mk-edit">
                          <select value={text} aria-label={`${sheet.name} ${addr}`} onChange={(e) => void setCell(sheet.name, addr, e.target.value)}>
                            <option value="" />
                            <option value="确认">确认</option>
                          </select>
                        </td>
                      );
                    }
                    return (
                      <td key={c} className={`mk-ro ${c === 4 && text.startsWith('✔') ? 'ok' : c === 4 && text.startsWith('✘') ? 'bad' : ''}`} colSpan={1}>
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
      <datalist id="mk-targets">
        {TARGET_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <p className="mk-foot">黄色单元格可填写；其余单元格由竞标程序写入，只读。页面每 1.5 秒自动刷新。</p>
    </div>
  );
}
