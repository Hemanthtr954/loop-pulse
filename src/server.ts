import { join } from 'node:path';
import { ConfigError, loadConfig, type Config } from './config.js';
import { openDatabase } from './db/database.js';
import { RepoStore } from './db/repo-store.js';
import { buildApp } from './http/app.js';
import { killAllGit } from './ingest/git/git-runner.js';
import { GitSource } from './ingest/git/git-source.js';
import { GithubClient } from './ingest/github/github-client.js';
import { GithubSource } from './ingest/github/github-source.js';
import { SyncScheduler, SyncService } from './ingest/sync-service.js';
import { InsightService } from './insights/insight-service.js';
import { createLogger } from './logger.js';
import { NarrativeService } from './narrative/narrative-service.js';
import { createProvider } from './narrative/providers/index.js';

async function main(config: Config): Promise<void> {
  const log = createLogger(config);
  const db = openDatabase(join(config.dataDir, 'pulse.db'));
  const repos = new RepoStore(db);
  const now = Date.now;
  for (const ref of config.repos.tracked) repos.ensure(ref, now());

  const github = config.github.token
    ? new GithubSource(db, new GithubClient({ baseUrl: config.github.apiUrl, token: config.github.token }), config.github.maxPrsPerSync)
    : null;
  const sync = new SyncService({
    repos,
    git: new GitSource(db, { dataDir: config.dataDir, timeoutMs: config.sync.gitTimeoutMs }),
    github,
    lookbackDays: config.sync.lookbackDays,
    log,
    now,
  });
  const insights = new InsightService(db, now);
  const provider = createProvider(config.llm);
  const narrative = new NarrativeService(db, insights, provider, log, github !== null);

  const app = await buildApp({ config, db, repos, sync, insights, narrative, now }, log);
  const scheduler = new SyncScheduler(sync, repos, config.sync.intervalMinutes);

  await app.listen({ host: config.host, port: config.port });
  log.info(
    { repos: repos.list().map((r) => `${r.owner}/${r.name}`), llm: `${provider.name}:${provider.model}`, github: github !== null },
    'loop-pulse ready',
  );
  scheduler.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    scheduler.stop();
    killAllGit();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
main(config).catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
