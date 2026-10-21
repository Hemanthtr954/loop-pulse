import { useEffect, useRef, useState } from 'react';
import type { Week } from '../api';
import { dateLabel, num } from '../format';

/**
 * Commits per week as columns: one series (no legend box; the heading names it), thin
 * rounded columns from a single baseline, hairline grid, hover tooltip per column, and a
 * table view for screen readers and exact values.
 */
export function WeeklyChart({ weeks, median }: { weeks: Week[]; median: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  // Draw at the container's real pixel width so text and marks never scale with the viewport.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTable]);
  const H = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 34 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...weeks.map((w) => w.commits));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const band = innerW / Math.max(1, weeks.length);
  const barW = Math.min(24, band - 2);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const active = hover === null ? null : weeks[hover];

  return (
    <div className="chart">
      <div className="chart-head">
        <h3>
          Commits per week {median > 0 && <span className="muted small">· median {median} (line)</span>}
        </h3>
        <button className="link" onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {showTable ? (
        <table className="data">
          <thead>
            <tr><th>Week of</th><th className="n">Commits</th><th className="n">Authors</th><th className="n">Churn</th></tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart}>
                <td>{w.weekStart}{w.partial ? ' (partial)' : ''}</td>
                <td className="n">{num(w.commits)}</td>
                <td className="n">{num(w.authors)}</td>
                <td className="n">{num(w.churn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-body" ref={box} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Commits per week, ${weeks.length} weeks, peak ${num(max)}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="gridline" />
                <text x={pad.left - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{t}</text>
              </g>
            ))}
            {median > 0 && (
              <line x1={pad.left} x2={W - pad.right} y1={y(median)} y2={y(median)} className="median" />
            )}
            {weeks.map((w, i) => {
              const x = pad.left + i * band + (band - barW) / 2;
              const h = Math.max(0, y(0) - y(w.commits));
              return (
                <g key={w.weekStart}>
                  {h > 0 && <path d={columnPath(x, y(0), barW, h)} className={`bar${w.partial ? ' partial' : ''}${hover === i ? ' on' : ''}`} />}
                  <rect
                    x={pad.left + i * band}
                    y={pad.top}
                    width={band}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={0}
                    aria-label={`Week of ${w.weekStart}: ${w.commits} commits`}
                  />
                  {i % Math.ceil(weeks.length / Math.max(2, Math.floor(innerW / 90))) === 0 && (
                    <text x={pad.left + i * band + band / 2} y={H - 8} className="tick" textAnchor="middle">{dateLabel(w.weekStart)}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {active && hover !== null && (
            <div className="tooltip" style={{ left: `${((pad.left + hover * band + band / 2) / W) * 100}%` }}>
              <strong>Week of {dateLabel(active.weekStart)}</strong>
              <span>{num(active.commits)} commits · {num(active.authors)} authors</span>
              <span>{num(active.churn)} lines churn{active.partial ? ' · partial week' : ''}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A column with a 4px rounded top and a square base. */
function columnPath(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const top = base - h;
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

function niceStep(max: number): number {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
