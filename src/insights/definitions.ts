import { KNOWER_MIN_SHARE, ORPHAN_THRESHOLD } from './knowledge-risk.js';
import { STALE_AFTER_DAYS } from './reviews.js';

/** Metric definitions returned in every response's `meta`, so numbers never travel without meaning. */
const common = {
  period: 'Half-open UTC interval [from, to). Commits are placed by committer date (when they landed on the default branch).',
  commits: 'Non-merge commits reachable from the default branch. Merge commits are excluded; their content is counted on the merged commits.',
  churn: 'Lines added + lines deleted, excluding generated or vendored files (lockfiles, dist/, vendor/, minified bundles, snapshots).',
  bots: 'Accounts such as dependabot[bot] or renovate are excluded unless includeBots=true.',
};

export const DEFINITIONS = {
  contributors: {
    ...common,
    filesTouched: 'Distinct non-generated files the author changed.',
    mergedPrs: 'Distinct pull-request numbers found in the author’s squash-merge commit subjects ("… (#123)"). Totals also count classic merge commits.',
    coAuthored: 'Commits where the author appears in a Co-authored-by trailer.',
    newcomer: 'The author’s first commit in the synced history falls inside the period (null when history does not reach before the period).',
  },
  'knowledge-risk': {
    ...common,
    truckFactor: `Smallest number of authors whose departure leaves more than ${ORPHAN_THRESHOLD * 100}% of the files changed in the period without anyone who wrote at least ${KNOWER_MIN_SHARE * 100}% of their churn (greedy algorithm after Avelino et al., 2016).`,
    topShare: 'Share of churn written by the top author.',
    hhi: 'Herfindahl–Hirschman index of authors’ churn shares: 1 = one author, 1/n = n equal authors.',
    effectiveContributors: '1 / HHI — the number of equally active authors that would produce the same concentration.',
    silo: 'A hotspot changed by exactly one author in the period.',
  },
  activity: {
    ...common,
    weeks: 'ISO weeks (Monday 00:00 UTC). `partial` marks weeks cut by the period boundary; median and peak use full weeks only.',
    weekendCommitShare: 'Share of commits authored on Saturday or Sunday in the author’s own timezone.',
    previous: 'The period of equal length immediately before; null when it starts before the synced history.',
    reducedActivity: 'Authors with ≥ 10% of previous-period commits (and ≥ 3) who made ≤ 25% as many commits in this period.',
  },
  reviewers: {
    period: common.period.replace('Commits are placed by committer date (when they landed on the default branch).', 'Reviews are placed by submission time.'),
    reviews: 'Submitted pull-request reviews (approve, request changes, comment). Self-reviews and pending reviews are not counted.',
    reviewShare: 'Reviewer’s share of all reviews in the period.',
    reviewBacklog: 'PRs whose reviews have not been fetched yet; non-zero while a large first sync is still draining.',
  },
  flow: {
    period: 'PRs are placed by merge time.',
    timeToMergeHours: 'Hours from PR creation to merge (nearest-rank p50/p90).',
    timeToFirstReviewHours: 'Hours from PR creation to the first review by someone other than the author.',
    mergedWithoutReview: 'Merged PRs with no review from anyone other than the author.',
    staleOpen: `Open, non-draft PRs with no update for more than ${STALE_AFTER_DAYS} days, as of now.`,
  },
} as const;

export type InsightKind = keyof typeof DEFINITIONS;
