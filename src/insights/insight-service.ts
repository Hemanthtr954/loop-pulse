import type { Db } from '../db/database.js';
import type { RepoRow } from '../db/repo-store.js';
import { AppError } from '../domain/errors.js';
import type { Period } from '../domain/period.js';
import { computeActivity, type ActivityResult } from './activity.js';
import { computeContributors, type ContributorsResult } from './contributors.js';
import { computeKnowledgeRisk, type KnowledgeRiskResult } from './knowledge-risk.js';
import type { InsightQuery } from './query.js';
import { computeFlow, computeReviewers, type FlowResult, type ReviewersResult } from './reviews.js';

/** Bounded LRU (Map preserves insertion order; re-insert on hit). */
class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/**
 * Entry point for all insights. Enforces that a repo has data and that the period lies within
 * the synced history, and memoises results by (repo, data_version, query): a new sync bumps
 * data_version, so a stale cached result can never be served.
 */
export class InsightService {
  private readonly cache = new Lru<unknown>(500);

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  contributors(repo: RepoRow, period: Period, includeBots: boolean): ContributorsResult {
    const q = this.query(repo, period, includeBots);
    return this.memo(repo, 'contributors', q, () => computeContributors(this.db, q, repo.horizon!));
  }

  knowledgeRisk(repo: RepoRow, period: Period, includeBots: boolean): KnowledgeRiskResult {
    const q = this.query(repo, period, includeBots);
    return this.memo(repo, 'knowledge-risk', q, () => computeKnowledgeRisk(this.db, q, { hotspots: 50, areas: 50 }));
  }

  activity(repo: RepoRow, period: Period, includeBots: boolean): ActivityResult {
    const q = this.query(repo, period, includeBots);
    return this.memo(repo, 'activity', q, () => computeActivity(this.db, q, repo.horizon!));
  }

  reviewers(repo: RepoRow, period: Period, includeBots: boolean, limit: number): ReviewersResult {
    const q = this.query(repo, period, includeBots);
    return this.memo(repo, `reviewers:${limit}`, q, () => computeReviewers(this.db, q, limit));
  }

  /** Not memoised across days: stale-open depends on "now". */
  flow(repo: RepoRow, period: Period, includeBots: boolean): FlowResult {
    const q = this.query(repo, period, includeBots);
    const day = Math.floor(this.now() / 86_400_000);
    return this.memo(repo, `flow:${day}`, q, () => computeFlow(this.db, q, this.now()));
  }

  /** Throws the right problem if the repo cannot answer queries for `period` yet. */
  assertQueryable(repo: RepoRow, period: Period): void {
    if (repo.head_sha === null || repo.horizon === null) {
      const syncing = repo.sync_status === 'pending' || repo.sync_status === 'syncing';
      throw AppError.conflict(
        'repo-not-ready',
        'Repository not synced yet',
        syncing
          ? 'The first sync of this repository is still running. Retry shortly.'
          : `The repository could not be synced: ${repo.sync_error ?? 'unknown error'}`,
        { syncStatus: repo.sync_status },
        syncing ? { 'retry-after': '5' } : {},
      );
    }
    if (period.from < repo.horizon) {
      throw AppError.unprocessable(
        'period-out-of-range',
        'Period outside synced history',
        `Data is available from ${new Date(repo.horizon).toISOString().slice(0, 10)}; raise SYNC_LOOKBACK_DAYS to look further back.`,
        { availableFrom: new Date(repo.horizon).toISOString() },
      );
    }
  }

  private query(repo: RepoRow, period: Period, includeBots: boolean): InsightQuery {
    this.assertQueryable(repo, period);
    return { repoId: repo.id, period, includeBots };
  }

  private memo<T>(repo: RepoRow, kind: string, q: InsightQuery, compute: () => T): T {
    const key = `${repo.id}:${repo.data_version}:${kind}:${q.period.from}:${q.period.to}:${q.includeBots}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;
    const value = compute();
    this.cache.set(key, value);
    return value;
  }
}
