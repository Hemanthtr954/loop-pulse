import type { FastifyBaseLogger } from 'fastify';
import type { RepoStore } from '../db/repo-store.js';
import { DAY_MS, startOfUtcDay } from '../domain/period.js';
import type { GitSource } from './git/git-source.js';
import type { GithubSource } from './github/github-source.js';

export interface SyncServiceDeps {
  repos: RepoStore;
  git: GitSource;
  github: GithubSource | null;
  lookbackDays: number;
  log: FastifyBaseLogger;
  now?: () => number;
  concurrency?: number;
}

/**
 * Orchestrates per-repo syncs: single flight per repo, bounded global concurrency, and
 * failures recorded on the repo instead of thrown at callers.
 */
export class SyncService {
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(private readonly deps: SyncServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.concurrency = deps.concurrency ?? 2;
  }

  get githubEnabled(): boolean {
    return this.deps.github !== null;
  }

  /** The earliest instant for which local data is complete. */
  horizon(): number {
    return startOfUtcDay(this.now() - this.deps.lookbackDays * DAY_MS);
  }

  /** Starts (or joins) a sync of `repoId`. Never rejects. */
  sync(repoId: number): Promise<void> {
    const existing = this.inflight.get(repoId);
    if (existing) return existing;
    const p = this.withSlot(() => this.run(repoId)).finally(() => this.inflight.delete(repoId));
    this.inflight.set(repoId, p);
    return p;
  }

  isSyncing(repoId: number): boolean {
    return this.inflight.has(repoId);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async run(repoId: number): Promise<void> {
    const { repos, git, github, log } = this.deps;
    const repo = repos.get(repoId);
    const slug = `${repo.owner}/${repo.name}`;
    const horizon = this.horizon();
    repos.markSyncing(repoId);

    try {
      const r = await git.sync(repo, horizon);
      repos.markReady(repoId, { branch: r.branch, headSha: r.headSha, horizon, changed: r.changed, now: this.now() });
      log.info({ repo: slug, ...r }, 'git sync complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repos.markFailed(repoId, message);
      log.warn({ repo: slug, err: message }, 'git sync failed');
      return;
    }

    if (!github) return;
    try {
      const g = await github.sync(repos.get(repoId), horizon);
      repos.recordGithub(repoId, { cursor: g.cursor, etag: g.etag, status: g.status, changed: g.changed, now: this.now() });
      log.info({ repo: slug, ...g }, 'github sync complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repos.recordGithub(repoId, { cursor: null, etag: null, status: `error: ${message.slice(0, 300)}`, changed: false, now: this.now() });
      log.warn({ repo: slug, err: message }, 'github sync failed');
    }
  }
}

/** Periodically refreshes every registered repo, with jitter so syncs do not align. */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly repos: RepoStore,
    private readonly intervalMinutes: number,
  ) {}

  start(): void {
    for (const repo of this.repos.list()) void this.sync.sync(repo.id);
    if (this.intervalMinutes > 0) this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const base = this.intervalMinutes * 60_000;
    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    this.timer = setTimeout(() => {
      for (const repo of this.repos.list()) void this.sync.sync(repo.id);
      this.schedule();
    }, base + jitter);
    this.timer.unref();
  }
}
