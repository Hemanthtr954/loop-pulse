import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { NarrativeService } from '../src/narrative/narrative-service.js';
import { RulesProvider } from '../src/narrative/providers/rules.js';
import { FIXTURE_NOW } from './helpers/fixture-repo.js';
import { ingestFixture } from './helpers/setup.js';

describe('secrets never reach the logs', () => {
  it('redacts api keys and authorization headers, even at trace level with headers logged', async () => {
    const chunks: string[] = [];
    const sink = new Writable({ write: (c, _e, cb) => (chunks.push(String(c)), cb()) });
    const log = createLogger({ logLevel: 'trace', env: 'production' }, sink);
    const h = await ingestFixture();
    const config = loadConfig({ NODE_ENV: 'test', TRACKED_REPOS: 'acme/widgets', API_KEY: 'super-secret-key', WEB_DIST_DIR: '/none' });
    const narrative = new NarrativeService(h.db, h.insights, new RulesProvider(), log, false);
    const app = await buildApp({ config, db: h.db, repos: h.repos, sync: h.sync, insights: h.insights, narrative, now: () => FIXTURE_NOW }, log);
    // Simulates a careless debug log of all request headers.
    app.addHook('onRequest', async (req) => req.log.info({ headers: req.headers }, 'headers'));

    await app.inject({ method: 'POST', url: '/v1/repos/acme/widgets/sync', headers: { 'x-api-key': 'super-secret-key', authorization: 'Bearer ghp_abc123' } });
    await app.close();

    const out = chunks.join('');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('super-secret-key');
    expect(out).not.toContain('ghp_abc123');
  });
});

describe('query plans', () => {
  it('period queries use the (repo_id, committed_at) index', async () => {
    const h = await ingestFixture();
    const plan = h.db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM commits c WHERE c.repo_id = ? AND c.committed_at >= ? AND c.committed_at < ?')
      .all(1, 0, 1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/commits_by_time/);
  });
});
