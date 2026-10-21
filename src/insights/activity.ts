import type { Db } from '../db/database.js';
import { DAY_MS, previousPeriod } from '../domain/period.js';
import { computeContributors, type Contributor } from './contributors.js';
import { round, share, type InsightQuery } from './query.js';

const WEEK_MS = 7 * DAY_MS;
/** Epoch day 0 (1970-01-01) was a Thursday; Monday-based weeks start 3 days earlier. */
const MONDAY_OFFSET_MS = 3 * DAY_MS;

export interface WeekBucket {
  weekStart: string;
  commits: number;
  authors: number;
  churn: number;
  mergedPrs: number;
  /** true when the week is cut by the period boundary */
  partial: boolean;
}

export interface PeriodTotals {
  commits: number;
  authors: number;
  churn: number;
  mergedPrs: number;
}

export interface ContributorShift {
  id: string;
  name: string;
  login: string | null;
  previousCommits: number;
  currentCommits: number;
  previousShare: number;
}

export interface ActivityResult {
  weeks: WeekBucket[];
  totals: PeriodTotals & { weekendCommitShare: number; medianWeeklyCommits: number; peakWeek: WeekBucket | null };
  previous: {
    period: { from: string; to: string };
    totals: PeriodTotals;
    change: { commits: number | null; authors: number | null; churn: number | null; mergedPrs: number | null };
    /** Authors with ≥10% of previous-period commits who made ≤25% as many commits now. */
    reducedActivity: ContributorShift[];
    newcomers: { count: number; commits: number; names: string[] };
  } | null;
  previousUnavailableReason: string | null;
}

export function weekStartOf(t: number): number {
  return Math.floor((t + MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS - MONDAY_OFFSET_MS;
}

export function computeActivity(db: Db, q: InsightQuery, horizon: number): ActivityResult {
  const bots = q.includeBots ? 1 : 0;
  const rows = db
    .prepare(
      `SELECT ((c.committed_at + ${MONDAY_OFFSET_MS}) / ${WEEK_MS}) * ${WEEK_MS} - ${MONDAY_OFFSET_MS} AS week,
              SUM(CASE WHEN c.is_merge = 0 THEN 1 ELSE 0 END) AS commits,
              COUNT(DISTINCT CASE WHEN c.is_merge = 0 THEN c.author_id END) AS authors,
              SUM(c.churn) AS churn,
              COUNT(DISTINCT c.pr_number) AS merged_prs
       FROM commits c JOIN authors a ON a.id = c.author_id
       WHERE c.repo_id = ? AND c.committed_at >= ? AND c.committed_at < ? AND (? = 1 OR a.is_bot = 0)
       GROUP BY week ORDER BY week`,
    )
    .all(q.repoId, q.period.from, q.period.to, bots) as { week: number; commits: number; authors: number; churn: number; merged_prs: number }[];

  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const weeks: WeekBucket[] = [];
  for (let w = weekStartOf(q.period.from); w < q.period.to; w += WEEK_MS) {
    const r = byWeek.get(w);
    weeks.push({
      weekStart: new Date(w).toISOString().slice(0, 10),
      commits: r?.commits ?? 0,
      authors: r?.authors ?? 0,
      churn: r?.churn ?? 0,
      mergedPrs: r?.merged_prs ?? 0,
      partial: w < q.period.from || w + WEEK_MS > q.period.to,
    });
  }

  const weekend = db
    .prepare(
      // Day of week in the author's own timezone: (epochDay + 4) % 7, with 0 = Sunday, 6 = Saturday.
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN (((c.authored_at + c.author_tz_min * 60000) / ${DAY_MS}) + 4) % 7 IN (0, 6) THEN 1 ELSE 0 END) AS weekend
       FROM commits c JOIN authors a ON a.id = c.author_id
       WHERE c.repo_id = ? AND c.committed_at >= ? AND c.committed_at < ? AND c.is_merge = 0 AND (? = 1 OR a.is_bot = 0)`,
    )
    .get(q.repoId, q.period.from, q.period.to, bots) as { total: number; weekend: number | null };

  const current = computeContributors(db, q, horizon);
  const totals: PeriodTotals = {
    commits: current.totals.commits,
    authors: current.totals.authors,
    churn: current.totals.churn,
    mergedPrs: current.totals.mergedPrs,
  };

  // Median and peak consider full weeks only, so a 2-day edge week does not look like a slump.
  const fullWeeks = weeks.filter((w) => !w.partial);
  const sortedCommits = fullWeeks.map((w) => w.commits).sort((a, b) => a - b);
  const median = sortedCommits.length ? medianOf(sortedCommits) : 0;
  const peak = fullWeeks.reduce<WeekBucket | null>((best, w) => (!best || w.commits > best.commits ? w : best), null);

  const prev = previousPeriod(q.period);
  const result: ActivityResult = {
    weeks,
    totals: {
      ...totals,
      weekendCommitShare: round(share(weekend.weekend ?? 0, weekend.total)),
      medianWeeklyCommits: median,
      peakWeek: peak,
    },
    previous: null,
    previousUnavailableReason: null,
  };

  if (prev.from < horizon) {
    result.previousUnavailableReason = `the previous period starts before the synced history (${new Date(horizon).toISOString().slice(0, 10)})`;
    return result;
  }

  const before = computeContributors(db, { ...q, period: prev }, horizon);
  const prevTotals: PeriodTotals = {
    commits: before.totals.commits,
    authors: before.totals.authors,
    churn: before.totals.churn,
    mergedPrs: before.totals.mergedPrs,
  };
  result.previous = {
    period: { from: new Date(prev.from).toISOString(), to: new Date(prev.to).toISOString() },
    totals: prevTotals,
    change: {
      commits: relChange(totals.commits, prevTotals.commits),
      authors: relChange(totals.authors, prevTotals.authors),
      churn: relChange(totals.churn, prevTotals.churn),
      mergedPrs: relChange(totals.mergedPrs, prevTotals.mergedPrs),
    },
    reducedActivity: reducedActivity(before.items, current.items, prevTotals.commits),
    newcomers: newcomers(current.items),
  };
  return result;
}

function reducedActivity(before: Contributor[], now: Contributor[], prevTotal: number): ContributorShift[] {
  const current = new Map(now.map((c) => [c.id, c.commits]));
  return before
    .filter((b) => b.commits >= 3 && share(b.commits, prevTotal) >= 0.1)
    .map((b) => ({
      id: b.id,
      name: b.name,
      login: b.login,
      previousCommits: b.commits,
      currentCommits: current.get(b.id) ?? 0,
      previousShare: round(share(b.commits, prevTotal)),
    }))
    .filter((s) => s.currentCommits <= s.previousCommits * 0.25)
    .sort((a, b) => b.previousCommits - a.previousCommits);
}

function newcomers(now: Contributor[]): { count: number; commits: number; names: string[] } {
  const list = now.filter((c) => c.newcomer === true);
  return {
    count: list.length,
    commits: list.reduce((s, c) => s + c.commits, 0),
    names: list.sort((a, b) => b.commits - a.commits).slice(0, 5).map((c) => c.name),
  };
}

/** Relative change, or null when the baseline is zero (undefined growth). */
function relChange(now: number, before: number): number | null {
  return before > 0 ? round((now - before) / before) : null;
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

