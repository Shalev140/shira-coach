import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Timer, X } from 'lucide-react';
import { fmtDuration } from '../domain/util';

export interface RestState {
  endsAt: number;
  total: number;
}

let audioCtx: AudioContext | null = null;
function beep(times = 3) {
  try {
    // a context made outside a tap stays frozen on iPhone and would play this later, at the next tap —
    // no tap in this workout yet (e.g. a rest restored after a relaunch) → no sound rather than a late one
    const ctx = audioCtx;
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i === times - 1 ? 1175 : 880;
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.2);
    }
  } catch {
    /* audio blocked — vibration / visual still work */
  }
}

/** Unlocks audio on the first user gesture (mobile browsers require it). */
export function primeAudio() {
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // 'interrupted' (iPhone: a call, Siri, the app sent to the background) needs a resume too
    if (audioCtx.state !== 'running') void audioCtx.resume();
  } catch {
    /* ignore */
  }
}

/**
 * ±sec on a running or finished rest. Once the rest is over, "+15" counts from now
 * (15 more seconds with a full bar), not from the past end time, which left 1 s and
 * beeped again at once; "−15" then has nothing to shorten and changes nothing.
 */
export function adjustRest(rest: RestState, sec: number, now: number): RestState {
  const over = rest.endsAt <= now;
  if (over && sec < 0) return rest;
  const endsAt = Math.max(now + 1000, (over ? now : rest.endsAt) + sec * 1000);
  const total = over ? Math.max(5, Math.round((endsAt - now) / 1000)) : Math.max(5, rest.total + sec);
  return { endsAt, total };
}

/**
 * Rest timer driven by an absolute end time, so it stays correct when the
 * phone locks or the tab is backgrounded.
 */
export function RestTimer({
  rest,
  onChange,
  sound,
  vibrate,
}: {
  rest: RestState | null;
  onChange: (r: RestState | null) => void;
  sound: boolean;
  vibrate: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const fired = useRef<number | null>(null);
  useEffect(() => {
    if (!rest) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [rest]);
  const left = rest ? Math.ceil((rest.endsAt - now) / 1000) : 0;
  useEffect(() => {
    if (!rest || left > 0 || fired.current === rest.endsAt) return;
    fired.current = rest.endsAt;
    if (sound) beep();
    if (vibrate && navigator.vibrate) navigator.vibrate([180, 90, 180]);
  }, [left, rest, sound, vibrate]);

  if (!rest) return null;
  const over = left <= 0;
  const pct = Math.max(0, Math.min(1, (rest.endsAt - now) / (rest.total * 1000)));
  const adjust = (sec: number) => {
    const next = adjustRest(rest, sec, Date.now());
    if (next !== rest) onChange(next);
  };

  return (
    <div className={`rest-timer ${over ? 'over' : ''}`} role="timer" aria-live="off">
      <div className="rest-progress" style={{ transform: `scaleX(${pct})` }} />
      <div className="rest-inner">
        <Timer className="rest-icon" />
        <div className="rest-time num">{over ? `+${fmtDuration(-left)}` : fmtDuration(left)}</div>
        <div className="rest-label small">{over ? 'המנוחה הסתיימה' : 'מנוחה'}</div>
        <div className="row" style={{ gap: 6 }}>
          <button className="rest-btn" onClick={() => adjust(-15)} disabled={over} aria-label="הפחתת 15 שניות">
            <Minus size={16} />
            15
          </button>
          <button className="rest-btn" onClick={() => adjust(15)} aria-label="הוספת 15 שניות">
            <Plus size={16} />
            15
          </button>
          <button className="rest-btn close" onClick={() => onChange(null)} aria-label="סגירת טיימר">
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
