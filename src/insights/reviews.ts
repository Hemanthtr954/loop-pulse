import type { Db } from '../db/database.js';
import { DAY_MS } from '../domain/period.js';
import { hhi, percentile, round, share, type InsightQuery } from './query.js';

const HOUR_MS = 3_600_000;
export const STALE_AFTER_DAYS = 14;

export interface ReviewersResult {
  totals: { reviews: number; reviewers: number; prsReviewed: number };
  items: {
    login: string;
    isBot: boolean;
    reviews: number;
    approvals: number;
    changesRequested: number;
    comments: number;
    prsReviewed: number;
    reviewShare: number;
  }[];
  loadBalance: { topShare: number; hhi: number; effectiveReviewers: number | null };
  reviewBacklog: number;
}

/** Reviews submitted in the period (self-reviews and pending reviews are never stored). */
export function computeReviewers(db: Db, q: InsightQuery, limit: number): ReviewersResult {
  const rows = db
    .prepare(
      `SELECT reviewer_login AS login, MAX(reviewer_is_bot) AS is_bot, COUNT(*) AS reviews,
              SUM(state = 'APPROVED') AS approvals, SUM(state = 'CHANGES_REQUESTED') AS changes_requested,
              SUM(state = 'COMMENTED') AS comments, COUNT(DISTINCT pr_number) AS prs
       FROM reviews
       WHERE repo_id = ? AND submitted_at >= ? AND submitted_at < ? AND (? = 1 OR reviewer_is_bot = 0)
       GROUP BY reviewer_login`,
    )
    .all(q.repoId, q.period.from, q.period.to, q.includeBots ? 1 : 0) as {
    login: string;
    is_bot: number;
    reviews: number;
    approvals: number;
    changes_requested: number;
    comments: number;
    prs: number;
  }[];

  const total = rows.reduce((s, r) => s + r.reviews, 0);
  const prsReviewed = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT pr_number) AS n FROM reviews
         WHERE repo_id = ? AND submitted_at >= ? AND submitted_at < ? AND (? = 1 OR reviewer_is_bot = 0)`,
      )
      .get(q.repoId, q.period.from, q.period.to, q.includeBots ? 1 : 0) as { n: number }
  ).n;
  const shares = rows.map((r) => share(r.reviews, total));
  const h = hhi(shares);
  const backlog = (
    db.prepare('SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND reviews_pending = 1').get(q.repoId) as { n: number }
  ).n;

  return {
    totals: { reviews: total, reviewers: rows.length, prsReviewed },
    items: rows
      .map((r) => ({
        login: r.login,
        isBot: r.is_bot === 1,
        reviews: r.reviews,
        approvals: r.approvals,
        changesRequested: r.changes_requested,
        comments: r.comments,
        prsReviewed: r.prs,
        reviewShare: round(share(r.reviews, total)),
      }))
      .sort((a, b) => b.reviews - a.reviews || a.login.localeCompare(b.login))
      .slice(0, limit),
    loadBalance: { topShare: round(Math.max(0, ...shares)), hhi: round(h), effectiveReviewers: h > 0 ? round(1 / h, 2) : null },
    reviewBacklog: backlog,
  };
}

export interface FlowResult {
  merged: number;
  mergedWithoutReview: number;
  timeToMergeHours: { p50: number | null; p90: number | null };
  timeToFirstReviewHours: { p50: number | null; p90: number | null };
  staleOpen: { count: number; oldest: { number: number; idleDays: number }[] };
  reviewBacklog: number;
}

/** PRs merged in the period; stale-open is evaluated as of `now`, not the period. */
export function computeFlow(db: Db, q: InsightQuery, now: number): FlowResult {
  const bots = q.includeBots ? 1 : 0;
  const merged = db
    .prepare(
      `SELECT created_at, merged_at, first_review_at, reviews_pending FROM pull_requests
       WHERE repo_id = ? AND merged_at >= ? AND merged_at < ? AND (? = 1 OR author_is_bot = 0)`,
    )
    .all(q.repoId, q.period.from, q.period.to, bots) as {
    created_at: number;
    merged_at: number;
    first_review_at: number | null;
    reviews_pending: number;
  }[];

  const toMerge = merged.map((p) => (p.merged_at - p.created_at) / HOUR_MS).sort((a, b) => a - b);
  const toReview = merged
    .filter((p) => p.first_review_at !== null)
    .map((p) => (p.first_review_at! - p.created_at) / HOUR_MS)
    .sort((a, b) => a - b);
  const staleBefore = now - STALE_AFTER_DAYS * DAY_MS;
  const stale = db
    .prepare(
      `SELECT number, updated_at FROM pull_requests
       WHERE repo_id = ? AND state = 'open' AND draft = 0 AND updated_at < ? AND (? = 1 OR author_is_bot = 0)
       ORDER BY updated_at ASC`,
    )
    .all(q.repoId, staleBefore, bots) as { number: number; updated_at: number }[];
  const pct = (arr: number[], p: number) => {
    const v = percentile(arr, p);
    return v === null ? null : round(v, 1);
  };

  return {
    merged: merged.length,
    // Only PRs whose reviews have been fetched can be called "unreviewed".
    mergedWithoutReview: merged.filter((p) => p.first_review_at === null && p.reviews_pending === 0).length,
    timeToMergeHours: { p50: pct(toMerge, 50), p90: pct(toMerge, 90) },
    timeToFirstReviewHours: { p50: pct(toReview, 50), p90: pct(toReview, 90) },
    staleOpen: {
      count: stale.length,
      oldest: stale.slice(0, 5).map((s) => ({ number: s.number, idleDays: Math.floor((now - s.updated_at) / DAY_MS) })),
    },
    reviewBacklog: (
      db.prepare('SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND reviews_pending = 1').get(q.repoId) as { n: number }
    ).n,
  };
}
