/**
 * 大屏音效（浏览器合成，不需要音频文件）：
 * - 普通加码：短促的一声「叮」；
 * - 出现新的标王候选：上行琶音 + 和弦，明显区别于普通加码。
 * 浏览器要求页面先有一次点击/按键才允许播放声音，unlockAudio 在第一次交互时调用。
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx = ctx ?? new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

/** 是否已允许播放（页面有过一次点击或按键） */
export function audioReady(): boolean {
  return !!ctx && ctx.state === 'running';
}

export function unlockAudio(): void {
  const c = audio();
  if (c && c.state !== 'running') void c.resume().catch(() => {});
}

function tone(c: AudioContext, freq: number, start: number, dur: number, peak: number, type: OscillatorType = 'sine') {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** 普通加码提示音 */
export function playBid(): void {
  const c = audio();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(880, t);
  o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.55);
}

/** 标王音效：C–E–G–C 上行琶音，结尾大三和弦 */
export function playChampion(): void {
  const c = audio();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone(c, f, t + i * 0.12, 0.35, 0.2, 'triangle'));
  const chordAt = t + notes.length * 0.12;
  for (const f of [523.25, 659.25, 783.99, 1046.5]) tone(c, f, chordAt, 1.4, 0.12, 'triangle');
  tone(c, 2093, chordAt, 0.9, 0.05, 'sine');
}
