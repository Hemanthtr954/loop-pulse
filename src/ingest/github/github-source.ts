import { transaction, type Db } from '../../db/database.js';
import type { RepoRow } from '../../db/repo-store.js';
import { GithubClient, RateLimitedError } from './github-client.js';

/** The subset of GitHub's pull request / review payloads we rely on. */
export interface GhUser {
  login: string;
  type?: string;
}
export interface GhPull {
  number: number;
  state: 'open' | 'closed';
  draft?: boolean;
  user: GhUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}
export interface GhReview {
  id: number;
  user: GhUser | null;
  state: string;
  submitted_at: string | null;
}

export interface GithubSyncResult {
  status: string;
  changed: boolean;
  prsListed: number;
  reviewsFetchedFor: number;
  reviewBacklog: number;
}

const REVIEW_CONCURRENCY = 4;

const isBotUser = (u: GhUser | null): boolean => !!u && (u.type === 'Bot' || u.login.endsWith('[bot]'));

/**
 * Two-phase sync:
 *  1. List PRs newest-updated first until the stored cursor (cheap: 100 PRs per call) and
 *     upsert them, marking each as needing its reviews refreshed.
 *  2. Drain the review backlog, newest first, up to `maxPrsPerSync` PRs per run. Anything
 *     left is picked up next run, so a large first sync is spread over several runs instead
 *     of exhausting the rate limit.
 */
export class GithubSource {
  constructor(
    private readonly db: Db,
    private readonly client: GithubClient,
    private readonly maxPrsPerSync: number,
  ) {}

  async sync(repo: RepoRow, horizon: number): Promise<GithubSyncResult & { cursor: number | null; etag: string | null }> {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const cursor = Math.max(repo.github_cursor ?? 0, horizon);
    let newestSeen: number | null = null;
    let etag: string | null = null;
    let listed = 0;
    let status = 'ok';

    try {
      const pulls: GhPull[] = [];
      let firstPage = true;
      outer: for await (const page of this.client.paginate<GhPull>(
        `${base}/pulls`,
        { state: 'all', sort: 'updated', direction: 'desc', per_page: '100' },
        repo.github_etag,
      )) {
        if (firstPage) etag = page.etag;
        firstPage = false;
        if (page.notModified) break;
        for (const pr of page.items) {
          const updated = Date.parse(pr.updated_at);
          if (updated <= cursor) break outer;
          newestSeen = Math.max(newestSeen ?? 0, updated);
          pulls.push(pr);
        }
      }
      listed = pulls.length;
      this.upsertPulls(repo.id, pulls);
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      status = `rate_limited until ${new Date(err.resetAt).toISOString()}`;
    }

    let reviewed = 0;
    if (status === 'ok') {
      try {
        reviewed = await this.drainReviewBacklog(repo.id, base);
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        status = `rate_limited until ${new Date(err.resetAt).toISOString()}`;
      }
    }

    const backlog = (
      this.db.prepare('SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND reviews_pending = 1').get(repo.id) as { n: number }
    ).n;
    return {
      status: backlog > 0 && status === 'ok' ? `ok (${backlog} PRs awaiting review sync)` : status,
      changed: listed > 0 || reviewed > 0,
      prsListed: listed,
      reviewsFetchedFor: reviewed,
      reviewBacklog: backlog,
      // Only advance the cursor once listing finished; a rate-limited listing retries from the old cursor.
      cursor: status === 'ok' ? newestSeen : null,
      etag: status === 'ok' ? etag : null,
    };
  }

  private upsertPulls(repoId: number, pulls: GhPull[]): void {
    if (!pulls.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO pull_requests (repo_id, number, author_login, author_is_bot, state, draft, created_at, updated_at,
         merged_at, closed_at, reviews_pending)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)
       ON CONFLICT (repo_id, number) DO UPDATE SET state = excluded.state, draft = excluded.draft,
         updated_at = excluded.updated_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
         reviews_pending = 1`,
    );
    transaction(this.db, () => {
      for (const pr of pulls) {
        stmt.run(
          repoId,
          pr.number,
          pr.user?.login ?? null,
          isBotUser(pr.user) ? 1 : 0,
          pr.merged_at ? 'merged' : pr.state,
          pr.draft ? 1 : 0,
          Date.parse(pr.created_at),
          Date.parse(pr.updated_at),
          pr.merged_at ? Date.parse(pr.merged_at) : null,
          pr.closed_at ? Date.parse(pr.closed_at) : null,
        );
      }
    });
  }

  private async drainReviewBacklog(repoId: number, base: string): Promise<number> {
    const pending = this.db
      .prepare(
        `SELECT number, author_login FROM pull_requests WHERE repo_id = ? AND reviews_pending = 1
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(repoId, this.maxPrsPerSync) as { number: number; author_login: string | null }[];

    let done = 0;
    let index = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      while (!stopped && index < pending.length) {
        const pr = pending[index++]!;
        const reviews: GhReview[] = [];
        try {
          for await (const page of this.client.paginate<GhReview>(`${base}/pulls/${pr.number}/reviews`, { per_page: '100' })) {
            reviews.push(...page.items);
          }
        } catch (err) {
          stopped = true; // stop the other workers from spending more quota
          throw err;
        }
        this.storeReviews(repoId, pr.number, pr.author_login, reviews);
        done++;
      }
    };
    // Each worker stores its PR's reviews as soon as they arrive, so progress survives a rate-limit stop.
    await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, pending.length) }, worker));
    return done;
  }

  private storeReviews(repoId: number, prNumber: number, author: string | null, reviews: GhReview[]): void {
    const counted = reviews.filter(
      (r) => r.user && r.submitted_at && r.state !== 'PENDING' && r.user.login !== author,
    );
    const firstReview = counted.reduce<number | null>((min, r) => {
      const t = Date.parse(r.submitted_at!);
      return min === null || t < min ? t : min;
    }, null);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?').run(repoId, prNumber);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO reviews (repo_id, id, pr_number, reviewer_login, reviewer_is_bot, state, submitted_at)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (const r of counted) {
        insert.run(repoId, r.id, prNumber, r.user!.login, isBotUser(r.user) ? 1 : 0, r.state, Date.parse(r.submitted_at!));
      }
      this.db
        .prepare('UPDATE pull_requests SET first_review_at = ?, reviews_pending = 0 WHERE repo_id = ? AND number = ?')
        .run(firstReview, repoId, prNumber);
    });
  }
}
