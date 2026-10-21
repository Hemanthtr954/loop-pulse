import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/database.js';
import { RepoStore } from '../../src/db/repo-store.js';
import { buildApp } from '../../src/http/app.js';
import { GitSource } from '../../src/ingest/git/git-source.js';
import type { GithubSource } from '../../src/ingest/github/github-source.js';
import { SyncService } from '../../src/ingest/sync-service.js';
import { InsightService } from '../../src/insights/insight-service.js';
import { NarrativeService } from '../../src/narrative/narrative-service.js';
import { RulesProvider } from '../../src/narrative/providers/rules.js';
import type { NarrativeProvider } from '../../src/narrative/providers/types.js';
import { createFixtureRepo, FIXTURE_NOW } from './fixture-repo.js';

export const silentLog = pino({ level: 'silent' });

let cachedFixture: string | null = null;
/** The fixture repo is immutable, so one copy serves every test file in a worker. */
export function fixtureRepoDir(): string {
  return (cachedFixture ??= createFixtureRepo());
}

export interface Harness {
  db: ReturnType<typeof openDatabase>;
  repos: RepoStore;
  sync: SyncService;
  insights: InsightService;
  repoId: number;
}

export async function ingestFixture(opts: { github?: GithubSource | null; now?: number } = {}): Promise<Harness> {
  const repoDir = fixtureRepoDir();
  const db = openDatabase(':memory:');
  const repos = new RepoStore(db);
  const now = opts.now ?? FIXTURE_NOW;
  const { row } = repos.ensure({ owner: 'acme', name: 'widgets' }, now);
  const git = new GitSource(db, {
    dataDir: mkdtempSync(join(tmpdir(), 'pulse-data-')),
    timeoutMs: 30_000,
    remoteUrl: () => `file://${repoDir}`,
    allowFileProtocol: true,
  });
  const sync = new SyncService({ repos, git, github: opts.github ?? null, lookbackDays: 365, log: silentLog, now: () => now });
  await sync.sync(row.id);
  return { db, repos, sync, insights: new InsightService(db, () => now), repoId: row.id };
}

export async function buildTestApp(opts: { env?: Record<string, string>; provider?: NarrativeProvider } = {}) {
  const h = await ingestFixture();
  const config = loadConfig({ NODE_ENV: 'test', TRACKED_REPOS: 'acme/widgets', SYNC_INTERVAL_MINUTES: '0', WEB_DIST_DIR: '/nonexistent', ...opts.env });
  const narrative = new NarrativeService(h.db, h.insights, opts.provider ?? new RulesProvider(), silentLog, false);
  const app = await buildApp({ config, db: h.db, repos: h.repos, sync: h.sync, insights: h.insights, narrative, now: () => FIXTURE_NOW });
  return { app, ...h };
}
