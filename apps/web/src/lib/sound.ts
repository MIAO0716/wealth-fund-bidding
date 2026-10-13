/**
 * 大屏音效（浏览器实时合成，不需要音频文件）。三类声音各有几种可选，由管理端下拉选择：
 * - 普通加码：清脆叮 / 金币 / 鼓点 / 风铃；
 * - 新标王候选：上扬号角 / 烟花 / 凯旋 / 欢呼掌声；
 * - 开放本组（开始竞标）：敲锣 / 战鼓三通 / 鼓点 + 锣。
 * 浏览器要求页面先有一次点击/按键才允许播放声音，unlockAudio 在第一次交互时调用。
 */

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

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

function ready(): AudioContext | null {
  const c = audio();
  return c && c.state === 'running' ? c : null;
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = c.sampleRate * 2;
  noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** 单个音：可选滑音（freqEnd）与低通（brass 感） */
function tone(
  c: AudioContext,
  freq: number,
  start: number,
  dur: number,
  peak: number,
  type: OscillatorType = 'sine',
  opts: { freqEnd?: number; lowpass?: number; attack?: number } = {},
) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(opts.freqEnd, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + (opts.attack ?? 0.02));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  let node: AudioNode = o;
  if (opts.lowpass) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = opts.lowpass;
    o.connect(f);
    node = f;
  }
  node.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** 一段噪声：带通/低通滤波，用于鼓皮、爆炸、掌声 */
function burst(c: AudioContext, start: number, dur: number, peak: number, filter: BiquadFilterType, freq: number, q = 1) {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(start, Math.random());
  src.stop(start + dur + 0.05);
}

/** 低音鼓：快速下滑的正弦 + 鼓皮噪声 */
function drumHit(c: AudioContext, t: number, peak = 0.5) {
  tone(c, 140, t, 0.45, peak, 'sine', { freqEnd: 45, attack: 0.004 });
  burst(c, t, 0.12, peak * 0.5, 'lowpass', 900);
}

/** 锣：多个非整数倍泛音长衰减，音高略下沉 */
function gongHit(c: AudioContext, t: number, base = 98) {
  const partials: Array<[number, number, number]> = [
    [1, 0.32, 4.2],
    [1.47, 0.2, 3.4],
    [2.09, 0.16, 3.0],
    [2.56, 0.12, 2.6],
    [3.37, 0.08, 2.0],
    [4.21, 0.05, 1.6],
  ];
  for (const [ratio, amp, dur] of partials) tone(c, base * ratio, t, dur, amp, 'sine', { freqEnd: base * ratio * 0.985, attack: 0.01 });
  burst(c, t, 0.35, 0.25, 'lowpass', 1600);
}

// ------------------------------------------------------------------ 普通加码

const BID: Record<string, (c: AudioContext, t: number) => void> = {
  ding: (c, t) => tone(c, 880, t, 0.5, 0.18, 'sine', { freqEnd: 1320 }),
  coin: (c, t) => {
    tone(c, 988, t, 0.09, 0.12, 'square', { lowpass: 4000, attack: 0.004 });
    tone(c, 1319, t + 0.08, 0.45, 0.12, 'square', { lowpass: 4000, attack: 0.004 });
  },
  drum: (c, t) => {
    drumHit(c, t, 0.45);
    drumHit(c, t + 0.14, 0.3);
  },
  bell: (c, t) => {
    for (const [r, a] of [
      [1, 0.14],
      [2.76, 0.06],
      [5.4, 0.03],
    ] as const)
      tone(c, 1046.5 * r, t, 1.3, a, 'sine', { attack: 0.003 });
  },
};

// ------------------------------------------------------------------ 新标王候选

const CHAMPION: Record<string, (c: AudioContext, t: number) => void> = {
  // C–E–G–C 上行琶音，结尾大三和弦
  fanfare: (c, t) => {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => tone(c, f, t + i * 0.12, 0.35, 0.2, 'triangle'));
    const at = t + notes.length * 0.12;
    for (const f of notes) tone(c, f, at, 1.4, 0.12, 'triangle');
    tone(c, 2093, at, 0.9, 0.05, 'sine');
  },
  // 升空哨音 → 爆炸 → 噼啪
  firework: (c, t) => {
    tone(c, 500, t, 0.55, 0.08, 'sine', { freqEnd: 2200, attack: 0.05 });
    const boom = t + 0.55;
    burst(c, boom, 1.4, 0.6, 'lowpass', 700);
    tone(c, 90, boom, 0.9, 0.4, 'sine', { freqEnd: 40, attack: 0.005 });
    for (let i = 0; i < 26; i++) burst(c, boom + 0.25 + Math.random() * 1.3, 0.05, 0.12 + Math.random() * 0.12, 'bandpass', 2500 + Math.random() * 3000, 3);
  },
  // 铜管凯旋：G–C–E–G（附点）+ 长和弦
  trumpet: (c, t) => {
    const seq: Array<[number, number, number]> = [
      [392, 0, 0.16],
      [523.25, 0.16, 0.16],
      [659.25, 0.32, 0.16],
      [783.99, 0.48, 0.5],
      [659.25, 0.98, 0.14],
      [783.99, 1.12, 1.2],
    ];
    for (const [f, d, dur] of seq) tone(c, f, t + d, dur, 0.14, 'sawtooth', { lowpass: 2600, attack: 0.03 });
    for (const f of [392, 523.25, 659.25]) tone(c, f, t + 1.12, 1.2, 0.07, 'sawtooth', { lowpass: 1800, attack: 0.05 });
  },
  // 欢呼掌声：密集的拍手噪声 + 一声上扬
  cheer: (c, t) => {
    for (let i = 0; i < 140; i++) {
      const at = t + Math.random() * 2.4;
      burst(c, at, 0.04 + Math.random() * 0.03, 0.08 + Math.random() * 0.1, 'bandpass', 1200 + Math.random() * 1800, 1.5);
    }
    tone(c, 660, t, 0.6, 0.08, 'triangle', { freqEnd: 1320 });
  },
};

// ------------------------------------------------------------------ 开放本组

const GROUP_START: Record<string, (c: AudioContext, t: number) => void> = {
  gong: (c, t) => gongHit(c, t),
  // 堂鼓三通：咚 咚 咚——咚咚咚
  bigDrum: (c, t) => {
    [0, 0.42, 0.84, 1.4, 1.58, 1.76].forEach((d, i) => drumHit(c, t + d, i < 3 ? 0.55 : 0.6));
  },
  // 由慢到快的鼓点，最后一声锣
  gongDrum: (c, t) => {
    let at = t;
    for (let i = 0; i < 12; i++) {
      drumHit(c, at, 0.25 + i * 0.025);
      at += Math.max(0.07, 0.22 - i * 0.014);
    }
    gongHit(c, at + 0.05);
  },
  off: () => {},
};

function play(table: Record<string, (c: AudioContext, t: number) => void>, id: string, fallback: string) {
  const c = ready();
  if (!c) return;
  (table[id] ?? table[fallback])(c, c.currentTime + 0.02);
}

export const playBidSound = (id = 'ding') => play(BID, id, 'ding');
export const playChampionSound = (id = 'fanfare') => play(CHAMPION, id, 'fanfare');
export const playGroupStartSound = (id = 'gong') => play(GROUP_START, id, 'gong');
