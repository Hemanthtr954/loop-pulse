import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { RepoStore } from '../src/db/repo-store.js';
import { GithubClient, RateLimitedError } from '../src/ingest/github/github-client.js';
import { GithubSource, type GhPull, type GhReview } from '../src/ingest/github/github-source.js';
import { computeFlow, computeReviewers } from '../src/insights/reviews.js';

/**
 * The environment this was built in could not reach api.github.com, so these tests stand in for the
 * live API with responses shaped like GitHub's documented payloads.
 */
const API = 'https://api.github.test';
const T = (iso: string) => `${iso}T00:00:00Z`;

function pr(number: number, updated: string, extra: Partial<GhPull> = {}): GhPull {
  return {
    number,
    state: 'closed',
    draft: false,
    user: { login: 'author', type: 'User' },
    created_at: T('2026-03-01'),
    updated_at: T(updated),
    closed_at: T(updated),
    merged_at: T(updated),
    ...extra,
  };
}
const review = (id: number, login: string, state: string, at: string): GhReview => ({ id, user: { login, type: 'User' }, state, submitted_at: T(at) });

interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function stubFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => url.pathname + url.search === k || url.pathname === k);
    if (!key) return new Response('[]', { status: 404 });
    const r = typeof routes[key] === 'function' ? (routes[key] as () => Route)() : (routes[key] as Route);
    return new Response(r.status === 304 ? null : JSON.stringify(r.body ?? []), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

describe('GithubClient', () => {
  it('follows Link pagination on the same origin only and sends auth headers', async () => {
    const { impl, calls } = stubFetch({
      '/repos/o/r/pulls?per_page=1': { body: [1], headers: { link: `<${API}/repos/o/r/pulls?per_page=1&page=2>; rel="next"` } },
      '/repos/o/r/pulls?per_page=1&page=2': { body: [2], headers: { link: `<https://evil.test/steal?page=3>; rel="next"` } },
    });
    const client = new GithubClient({ baseUrl: API, token: 'secret', fetch: impl });
    const items: number[] = [];
    for await (const page of client.paginate<number>('/repos/o/r/pulls', { per_page: '1' })) items.push(...page.items);
    expect(items).toEqual([1, 2]);
    expect(calls).toHaveLength(2); // the cross-origin "next" link was not followed
    expect(calls[0]!.headers.authorization).toBe('Bearer secret');
  });

  it('turns an exhausted rate limit into RateLimitedError', async () => {
    const { impl } = stubFetch({ '/x': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } } });
    const client = new GithubClient({ baseUrl: API, token: undefined, fetch: impl });
    await expect(client.paginate('/x', {}).next()).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('GithubSource', () => {
  const setup = (routes: Record<string, Route | (() => Route)>, maxPrs = 100) => {
    const db = openDatabase(':memory:');
    const repos = new RepoStore(db);
    const { row } = repos.ensure({ owner: 'o', name: 'r' }, Date.now());
    const { impl, calls } = stubFetch(routes);
    const source = new GithubSource(db, new GithubClient({ baseUrl: API, token: 't', fetch: impl }), maxPrs);
    return { db, repos, row, source, calls };
  };
  const horizon = Date.parse('2026-01-01T00:00:00Z');

  it('lists PRs until the cursor, fetches reviews, ignores self/pending reviews', async () => {
    const { db, repos, row, source } = setup({
      '/repos/o/r/pulls': {
        body: [pr(3, '2026-03-10'), pr(2, '2026-03-05', { merged_at: null, state: 'open', closed_at: null }), pr(1, '2025-12-01')],
        headers: { etag: '"abc"' },
      },
      '/repos/o/r/pulls/3/reviews': {
        body: [review(10, 'rev1', 'APPROVED', '2026-03-02'), review(11, 'author', 'COMMENTED', '2026-03-01'), review(12, 'rev2', 'PENDING', '2026-03-03')],
      },
      '/repos/o/r/pulls/2/reviews': { body: [review(13, 'rev1', 'CHANGES_REQUESTED', '2026-03-04')] },
    });
    const r = await source.sync(row, horizon);
    expect(r).toMatchObject({ status: 'ok', prsListed: 2, reviewsFetchedFor: 2, reviewBacklog: 0, etag: '"abc"' });
    expect(r.cursor).toBe(Date.parse(T('2026-03-10')));
    repos.recordGithub(row.id, { cursor: r.cursor, etag: r.etag, status: r.status, changed: r.changed, now: Date.now() });

    const q = { repoId: row.id, period: { from: horizon, to: Date.parse(T('2026-04-01')) }, includeBots: false };
    const reviewers = computeReviewers(db, q, 10);
    expect(reviewers.totals).toEqual({ reviews: 2, reviewers: 1, prsReviewed: 2 });
    expect(reviewers.items[0]).toMatchObject({ login: 'rev1', approvals: 1, changesRequested: 1 });

    const flow = computeFlow(db, q, Date.parse(T('2026-04-01')));
    expect(flow.merged).toBe(1);
    expect(flow.timeToMergeHours.p50).toBe(9 * 24);
    expect(flow.timeToFirstReviewHours.p50).toBe(24);
    expect(flow.staleOpen.count).toBe(1);
  });

  it('stops cleanly on rate limiting and keeps the old cursor', async () => {
    const { row, source } = setup({ '/repos/o/r/pulls': { status: 429, headers: { 'retry-after': '60' } } });
    const r = await source.sync(row, horizon);
    expect(r.status).toMatch(/^rate_limited until/);
    expect(r.cursor).toBeNull();
  });

  it('spreads a large review backlog over several syncs', async () => {
    const pulls = Array.from({ length: 5 }, (_, i) => pr(i + 1, `2026-03-0${i + 1}`));
    const routes: Record<string, Route> = { '/repos/o/r/pulls': { body: pulls } };
    for (let i = 1; i <= 5; i++) routes[`/repos/o/r/pulls/${i}/reviews`] = { body: [] };
    const { row, source } = setup(routes, 2);
    const r = await source.sync(row, horizon);
    expect(r).toMatchObject({ reviewsFetchedFor: 2, reviewBacklog: 3 });
    expect(r.status).toMatch(/3 PRs awaiting review sync/);
  });
});
