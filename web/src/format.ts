const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (n: number) => nf.format(n);
export const short = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : nf.format(n));
export const pct = (ratio: number, digits = 0) => `${(ratio * 100).toFixed(digits)}%`;
export const signedPct = (ratio: number) => `${ratio > 0 ? '+' : ratio < 0 ? '−' : ''}${Math.abs(ratio * 100).toFixed(0)}%`;
export const who = (a: { name: string; login: string | null }) => a.name;
export const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const DAY = 86_400_000;
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
