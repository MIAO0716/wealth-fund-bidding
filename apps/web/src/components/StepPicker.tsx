/**
 * 追加幅度选择：每次加码为 1 的整数倍（组内自由加码）。
 * 快捷档位 + 「−」「＋」逐 1 调整，也可以直接输入整数；服务端独立校验，不依赖这里的限制。
 */
import { useEffect, useState } from 'react';

const MAX_STEP = 1000;
const clamp = (n: number) => Math.max(1, Math.min(MAX_STEP, Math.round(n)));

export function StepPicker(props: { steps: readonly number[]; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const { steps, value, onChange, disabled } = props;
  // 输入框里的文字单独保存：允许临时清空再输入
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="step-picker">
      <div className="sp-row">
        <button type="button" className="sp-btn" aria-label="减少 1 个百分点" disabled={disabled || value <= 1} onClick={() => onChange(clamp(value - 1))}>
          −
        </button>
        <label className="sp-value">
          <span className="num">+</span>
          <input
            className="num"
            inputMode="numeric"
            aria-label="追加百分点"
            value={text}
            disabled={disabled}
            onChange={(e) => {
              const t = e.target.value.replace(/[^\d]/g, '').slice(0, 4);
              setText(t);
              if (t) onChange(clamp(Number(t)));
            }}
            onBlur={() => setText(String(value))}
          />
          <small>个百分点</small>
        </label>
        <button type="button" className="sp-btn" aria-label="增加 1 个百分点" disabled={disabled || value >= MAX_STEP} onClick={() => onChange(clamp(value + 1))}>
          ＋
        </button>
      </div>
      <div className="m-steps" style={{ gridTemplateColumns: `repeat(${Math.min(steps.length, 4)}, 1fr)` }}>
        {steps.map((s) => (
          <button type="button" key={s} className={`m-step ${s === value ? 'on' : ''}`} onClick={() => onChange(s)} disabled={disabled}>
            +{s}
            <small>个百分点</small>
          </button>
        ))}
      </div>
    </div>
  );
}
