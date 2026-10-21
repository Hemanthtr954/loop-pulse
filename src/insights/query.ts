import type { Period } from '../domain/period.js';

/** Everything an insight needs to run a query; built by the HTTP layer after validation. */
export interface InsightQuery {
  readonly repoId: number;
  readonly period: Period;
  readonly includeBots: boolean;
}

/** SQL fragment + params restricting commits to the query's period (and humans, by default). */
export function commitScope(q: InsightQuery, alias = 'c', authorAlias = 'a'): { sql: string; params: number[] } {
  return {
    sql: `${alias}.repo_id = ? AND ${alias}.committed_at >= ? AND ${alias}.committed_at < ? AND (? = 1 OR ${authorAlias}.is_bot = 0)`,
    params: [q.repoId, q.period.from, q.period.to, q.includeBots ? 1 : 0],
  };
}

export function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** Rounds to `digits` decimals; used only at the API boundary so internal math stays exact. */
export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Herfindahl–Hirschman index of a list of shares (0..1). */
export function hhi(shares: number[]): number {
  return shares.reduce((sum, s) => sum + s * s, 0);
}

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
