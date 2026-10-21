import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../src/domain/period.js';
import { computeContributors } from '../src/insights/contributors.js';
import { computeKnowledgeRisk } from '../src/insights/knowledge-risk.js';
import { computeActivity } from '../src/insights/activity.js';
import { EXPECTED, FIXTURE_NOW, PERIOD } from './helpers/fixture-repo.js';
import { ingestFixture } from './helpers/setup.js';

/**
 * End-to-end over a real git repository whose history is scripted with known numbers:
 * clone → shallow mirror → streaming parse → SQLite → insight SQL.
 */
describe('git ingestion against a scripted repository', async () => {
  const h = await ingestFixture();
  const repo = h.repos.get(h.repoId);
  const q = { repoId: h.repoId, period: resolvePeriod(PERIOD, FIXTURE_NOW), includeBots: false };

  it('marks the repo ready with the default branch and a horizon', () => {
    expect(repo.sync_status).toBe('ready');
    expect(repo.default_branch).toBe('main');
    expect(repo.horizon).toBe(Date.parse('2025-06-15T00:00:00Z'));
    expect(repo.data_version).toBe(1);
  });

  it('never ingests commits older than the horizon', () => {
    const oldest = h.db.prepare('SELECT MIN(committed_at) AS t FROM commits').get() as { t: number };
    expect(oldest.t).toBeGreaterThanOrEqual(repo.horizon!);
  });

  it('stores the shallow boundary commit without inventing whole-tree line counts', () => {
    const boundary = h.db
      .prepare("SELECT additions, stats_complete FROM commits WHERE committed_at = ?")
      .get(Date.parse('2025-08-01T10:00:00Z')) as { additions: number; stats_complete: number };
    expect(boundary).toEqual({ additions: 0, stats_complete: 0 });
  });

  it('computes contributor totals that match the scripted history exactly', () => {
    const r = computeContributors(h.db, q, repo.horizon!);
    expect(r.totals).toMatchObject({
      commits: EXPECTED.commits,
      authors: EXPECTED.authors,
      additions: EXPECTED.additions,
      deletions: EXPECTED.deletions,
      churn: EXPECTED.churn,
      mergedPrs: EXPECTED.mergedPrs,
      botCommits: EXPECTED.botCommits,
    });
    for (const [name, expected] of Object.entries(EXPECTED.byAuthor)) {
      expect(r.items.find((c) => c.name === name), name).toMatchObject(expected);
    }
    // Shares add up to one.
    expect(r.items.reduce((s, c) => s + c.churnShare, 0)).toBeCloseTo(1, 3);
  });

  it('derives logins from GitHub noreply addresses and never exposes e-mails', () => {
    const r = computeContributors(h.db, q, repo.horizon!);
    const bob = r.items.find((c) => c.name === 'Bob Roe')!;
    expect(bob.login).toBe('bobr');
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it('includes bots only when asked', () => {
    const r = computeContributors(h.db, { ...q, includeBots: true }, repo.horizon!);
    expect(r.totals.commits).toBe(EXPECTED.commits + 1);
    expect(r.items.find((c) => c.isBot)?.login).toBe('dependabot[bot]');
  });

  it('computes knowledge risk with renames attributed to the new path', () => {
    const k = computeKnowledgeRisk(h.db, q);
    expect(k.filesTouched).toBe(EXPECTED.filesTouched);
    expect(k.truckFactor).toBe(EXPECTED.truckFactor);
    expect(k.concentration.topShare).toBeCloseTo(EXPECTED.topShare, 3);
    expect(k.concentration.hhi).toBeCloseTo(EXPECTED.hhi, 3);
    expect(k.concentration.topAuthor?.name).toBe('Carol Poe');
    const paths = k.hotspots.map((x) => x.path);
    expect(paths).toContain('lib/b.js');
    expect(paths).not.toContain('package-lock.json');
  });

  it('counts weekend work in the author’s own timezone', () => {
    const a = computeActivity(h.db, q, repo.horizon!);
    expect(a.totals.weekendCommitShare).toBeCloseTo(EXPECTED.weekendCommits / EXPECTED.commits, 3);
    expect(a.weeks.reduce((s, w) => s + w.commits, 0)).toBe(EXPECTED.commits);
  });

  it('skips re-ingestion when nothing changed upstream', async () => {
    await h.sync.sync(h.repoId);
    expect(h.repos.get(h.repoId).data_version).toBe(1);
  });
});
