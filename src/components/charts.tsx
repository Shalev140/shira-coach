import { useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtNum } from '../domain/util';

export interface Point {
  x: string; // YYYY-MM-DD
  y: number;
  note?: string;
}

/**
 * Element width via a callback ref, so the observer attaches whenever the element
 * mounts — also when the chart first rendered its empty state and data came later.
 */
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [el]);
  return [el, setEl, w] as const;
}

const dayMs = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

/**
 * Single-series line chart (one measure per chart — never a dual axis).
 * Time runs left→right; a crosshair + tooltip follows the pointer / finger.
 */
export function LineChart({
  points,
  height = 200,
  unit = '',
  digits = 1,
  color = 'var(--accent)',
  label,
  target,
}: {
  points: Point[];
  height?: number;
  unit?: string;
  digits?: number;
  color?: string;
  label?: string;
  target?: number | null;
}) {
  const [wrapEl, wrapRef, W] = useWidth<HTMLDivElement>();
  const [hoverIdx, setHover] = useState<number | null>(null);
  // The stored index can outlive a switch to a shorter series (metric / exercise /
  // range change while the finger or mouse still "hovers") — never read past the end.
  const hover = hoverIdx !== null && hoverIdx < points.length ? hoverIdx : null;
  const H = height;
  const pad = { l: 40, r: 14, t: 16, b: 26 };

  const geo = useMemo(() => {
    if (!points.length || !W) return null;
    const ys = points.map((p) => p.y).concat(target != null ? [target] : []);
    let min = Math.min(...ys);
    let max = Math.max(...ys);
    if (min === max) {
      min -= Math.max(1, Math.abs(min) * 0.08);
      max += Math.max(1, Math.abs(max) * 0.08);
    }
    const span = max - min;
    min -= span * 0.14;
    max += span * 0.14;
    const t0 = dayMs(points[0].x);
    const t1 = dayMs(points[points.length - 1].x);
    const tx = (x: string) => (t1 === t0 ? (pad.l + W - pad.r) / 2 : pad.l + ((dayMs(x) - t0) / (t1 - t0)) * (W - pad.l - pad.r));
    const ty = (y: number) => pad.t + (1 - (y - min) / (max - min)) * (H - pad.t - pad.b);
    const ticks = [0.15, 0.5, 0.85].map((f) => min + (max - min) * f);
    return { tx, ty, ticks };
  }, [points, target, H, W]);

  const onMove = (clientX: number) => {
    if (!wrapEl || !geo) return;
    const x = clientX - wrapEl.getBoundingClientRect().left;
    let best = 0;
    let bd = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geo.tx(p.x) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  if (!points.length) return <div className="empty small">אין עדיין נתונים לגרף</div>;

  return (
    <div ref={wrapRef} className="chart" style={{ direction: 'ltr', position: 'relative', height: H }}>
      {geo && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={label}
          onMouseMove={(e) => onMove(e.clientX)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => onMove(e.touches[0].clientX)}
          onTouchMove={(e) => onMove(e.touches[0].clientX)}
          style={{ display: 'block', touchAction: 'pan-y' }}
        >
          <defs>
            <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.16" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={geo.ty(t)} y2={geo.ty(t)} stroke="var(--border)" strokeWidth="1" />
              <text x={pad.l - 8} y={geo.ty(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                {fmtNum(t, digits)}
              </text>
            </g>
          ))}
          {target != null && (
            <g>
              <line x1={pad.l} x2={W - pad.r} y1={geo.ty(target)} y2={geo.ty(target)} stroke="var(--ink-2)" strokeDasharray="4 4" strokeWidth="1.2" />
              <text x={W - pad.r} y={geo.ty(target) - 5} textAnchor="end" fontSize="11" fill="var(--ink-2)">
                יעד {fmtNum(target, digits)}
              </text>
            </g>
          )}
          {(() => {
            const d = points.map((p, i) => `${i ? 'L' : 'M'}${geo.tx(p.x).toFixed(1)},${geo.ty(p.y).toFixed(1)}`).join(' ');
            const area = `${d} L${geo.tx(points[points.length - 1].x).toFixed(1)},${H - pad.b} L${geo.tx(points[0].x).toFixed(1)},${H - pad.b} Z`;
            return (
              <>
                {points.length > 1 && <path d={area} fill="url(#lc-fill)" />}
                <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              </>
            );
          })()}
          {hover !== null && (
            <line x1={geo.tx(points[hover].x)} x2={geo.tx(points[hover].x)} y1={pad.t - 6} y2={H - pad.b} stroke="var(--faint)" strokeWidth="1" />
          )}
          {points.map((p, i) => {
            const big = i === hover || i === points.length - 1;
            return <circle key={i} cx={geo.tx(p.x)} cy={geo.ty(p.y)} r={big ? 5 : 4} fill={color} stroke="var(--surface)" strokeWidth="2" />;
          })}
          <text x={pad.l} y={H - 7} fontSize="11" fill="var(--muted)">
            {fmtDate(points[0].x)}
          </text>
          {points.length > 1 && (
            <text x={W - pad.r} y={H - 7} fontSize="11" fill="var(--muted)" textAnchor="end">
              {fmtDate(points[points.length - 1].x)}
            </text>
          )}
        </svg>
      )}
      {geo && hover !== null && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(W - 70, Math.max(70, geo.tx(points[hover].x))),
            top: Math.max(-6, geo.ty(points[hover].y) - 62),
          }}
        >
          <div className="strong num">
            {fmtNum(points[hover].y, digits)}
            {unit && ` ${unit}`}
          </div>
          <div className="tiny muted" style={{ direction: 'rtl' }}>
            {fmtDate(points[hover].x)}
            {points[hover].note ? ` · ${points[hover].note}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 84, height = 28, color = 'var(--accent)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 8) + 4, height - 4 - ((v - min) / span) * (height - 8)]);
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} style={{ direction: 'ltr', flex: 'none' }} aria-hidden>
      <polyline points={pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="3.5" fill={color} stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Weekly volume bar: direct sets (solid) + weighted indirect sets (lighter step
 * of the same hue) on one scale, with the client's target range as a band.
 */
export function VolumeBar({
  direct,
  indirect,
  target,
  scaleMax,
}: {
  direct: number;
  indirect: number;
  target?: { min: number; max: number };
  scaleMax: number;
}) {
  const pct = (v: number) => Math.min(100, (v / scaleMax) * 100);
  return (
    <div className="vbar" aria-hidden>
      {target && <div className="vbar-target" style={{ insetInlineStart: `${pct(target.min)}%`, width: `${pct(target.max) - pct(target.min)}%` }} />}
      <div className="vbar-fill">
        {direct > 0 && <i className="vbar-direct" style={{ width: `${pct(direct)}%` }} />}
        {indirect > 0 && <i className="vbar-indirect" style={{ width: `${pct(indirect)}%` }} />}
      </div>
    </div>
  );
}
