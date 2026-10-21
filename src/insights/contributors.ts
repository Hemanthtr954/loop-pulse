import type { Db } from '../db/database.js';
import { commitScope, round, share, type InsightQuery } from './query.js';

export const CONTRIBUTOR_SORTS = ['commits', 'churn', 'filesTouched', 'mergedPrs'] as const;
export type ContributorSort = (typeof CONTRIBUTOR_SORTS)[number];

export interface Contributor {
  id: string;
  name: string;
  login: string | null;
  isBot: boolean;
  commits: number;
  additions: number;
  deletions: number;
  churn: number;
  filesTouched: number;
  activeDays: number;
  mergedPrs: number;
  coAuthored: number;
  commitShare: number;
  churnShare: number;
  /** true when the author's first commit in the stored history falls inside the period */
  newcomer: boolean | null;
}

export interface ContributorsResult {
  totals: {
    commits: number;
    authors: number;
    additions: number;
    deletions: number;
    churn: number;
    mergedPrs: number;
    botCommits: number;
    incompleteCommits: number;
  };
  items: Contributor[];
}

interface Row {
  author_id: number;
  public_id: string;
  name: string;
  login: string | null;
  is_bot: number;
  commits: number;
  additions: number;
  deletions: number;
  churn: number;
  active_days: number;
  merged_prs: number;
  first_seen: number;
}

/**
 * Per-author activity on the default branch in the period. Merge commits are excluded (their
 * content is already counted on the merged commits); churn excludes generated paths.
 * Returns *all* authors; sorting and limiting happen in `rankContributors`.
 */
export function computeContributors(db: Db, q: InsightQuery, horizon: number): ContributorsResult {
  const scope = commitScope(q);
  const rows = db
    .prepare(
      `SELECT a.id AS author_id, a.public_id, a.name, a.login, a.is_bot,
              COUNT(*) AS commits, SUM(c.additions) AS additions, SUM(c.deletions) AS deletions, SUM(c.churn) AS churn,
              COUNT(DISTINCT c.committed_at / 86400000) AS active_days,
              COUNT(DISTINCT c.pr_number) AS merged_prs,
              (SELECT MIN(c2.committed_at) FROM commits c2 WHERE c2.repo_id = c.repo_id AND c2.author_id = a.id AND c2.is_merge = 0) AS first_seen
       FROM commits c JOIN authors a ON a.id = c.author_id
       WHERE ${scope.sql} AND c.is_merge = 0
       GROUP BY a.id`,
    )
    .all(...scope.params) as unknown as Row[];

  const files = new Map(
    (
      db
        .prepare(
          `SELECT c.author_id, COUNT(DISTINCT f.path) AS n
           FROM commits c JOIN authors a ON a.id = c.author_id
           JOIN file_changes f ON f.repo_id = c.repo_id AND f.sha = c.sha
           WHERE ${scope.sql} AND c.is_merge = 0 AND f.generated = 0
           GROUP BY c.author_id`,
        )
        .all(...scope.params) as { author_id: number; n: number }[]
    ).map((r) => [r.author_id, r.n]),
  );

  const coAuthored = new Map(
    (
      db
        .prepare(
          `SELECT ca.author_id, COUNT(*) AS n
           FROM co_authors ca JOIN commits c ON c.repo_id = ca.repo_id AND c.sha = ca.sha
           JOIN authors a ON a.id = ca.author_id
           WHERE ${scope.sql} AND c.is_merge = 0
           GROUP BY ca.author_id`,
        )
        .all(...scope.params) as { author_id: number; n: number }[]
    ).map((r) => [r.author_id, r.n]),
  );

  const totalsRow = db
    .prepare(
      // PR numbers come from squash subjects and merge commits alike, so this counts every
      // merged PR whose commit landed in the period (bots excluded unless requested).
      `SELECT COUNT(DISTINCT CASE WHEN (? = 1 OR a.is_bot = 0) THEN c.pr_number END) AS merged_prs,
              SUM(CASE WHEN a.is_bot = 1 AND c.is_merge = 0 THEN 1 ELSE 0 END) AS bot_commits,
              SUM(CASE WHEN c.stats_complete = 0 AND c.is_merge = 0 AND (? = 1 OR a.is_bot = 0) THEN 1 ELSE 0 END) AS incomplete
       FROM commits c JOIN authors a ON a.id = c.author_id
       WHERE c.repo_id = ? AND c.committed_at >= ? AND c.committed_at < ?`,
    )
    .get(q.includeBots ? 1 : 0, q.includeBots ? 1 : 0, q.repoId, q.period.from, q.period.to) as { merged_prs: number; bot_commits: number | null; incomplete: number | null };

  const totals = rows.reduce(
    (t, r) => ({
      commits: t.commits + r.commits,
      additions: t.additions + r.additions,
      deletions: t.deletions + r.deletions,
      churn: t.churn + r.churn,
    }),
    { commits: 0, additions: 0, deletions: 0, churn: 0 },
  );

  // Newcomer status is only knowable if stored history starts before the period.
  const canTellNewcomers = horizon < q.period.from;
  const items: Contributor[] = rows.map((r) => ({
    id: r.public_id,
    name: r.name,
    login: r.login,
    isBot: r.is_bot === 1,
    commits: r.commits,
    additions: r.additions,
    deletions: r.deletions,
    churn: r.churn,
    filesTouched: files.get(r.author_id) ?? 0,
    activeDays: r.active_days,
    mergedPrs: r.merged_prs,
    coAuthored: coAuthored.get(r.author_id) ?? 0,
    commitShare: round(share(r.commits, totals.commits)),
    churnShare: round(share(r.churn, totals.churn)),
    newcomer: canTellNewcomers ? r.first_seen >= q.period.from : null,
  }));

  return {
    totals: {
      ...totals,
      authors: rows.length,
      mergedPrs: totalsRow.merged_prs,
      botCommits: totalsRow.bot_commits ?? 0,
      incompleteCommits: totalsRow.incomplete ?? 0,
    },
    items,
  };
}

/** Deterministic ordering: metric desc, then commits desc, then name asc. */
export function rankContributors(items: Contributor[], sort: ContributorSort, limit: number): Contributor[] {
  return [...items]
    .sort((a, b) => b[sort] - a[sort] || b.commits - a.commits || a.name.localeCompare(b.name))
    .slice(0, limit);
}
