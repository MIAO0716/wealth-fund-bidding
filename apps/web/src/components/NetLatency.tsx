import { useEffect, useState } from 'react';

/** 网络延迟：每 5 秒请求一次服务器，显示往返时间（含服务器与数据库应答） */
export function NetLatency() {
  const [ms, setMs] = useState<number | null>(null);
  const [recent, setRecent] = useState<number[]>([]);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let stop = false;
    const probe = async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const t0 = performance.now();
      try {
        const r = await fetch('/healthz', { cache: 'no-store', signal: ac.signal });
        const t = Math.round(performance.now() - t0);
        if (stop) return;
        if (!r.ok) throw new Error(String(r.status));
        setDown(false);
        setMs(t);
        setRecent((h) => [...h.slice(-11), t]);
      } catch {
        if (!stop) setDown(true);
      } finally {
        clearTimeout(timer);
      }
    };
    void probe();
    const t = setInterval(() => void probe(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (down) return <span className="chip red" title="5 秒内没有收到服务器应答">网络延迟：无法连接服务器</span>;
  if (ms === null) return <span className="chip grey">网络延迟：测量中…</span>;
  const avg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
  const level = ms < 200 ? ['green', '良好'] : ms < 800 ? ['gold', '较慢'] : ['red', '很慢'];
  return (
    <span className={`chip ${level[0]}`} title={`最近 ${recent.length} 次平均 ${avg} ms，每 5 秒测一次`}>
      网络延迟 {ms} ms · {level[1]}
      <span className="small" style={{ opacity: 0.75, marginLeft: 6 }}>平均 {avg} ms</span>
    </span>
  );
}
