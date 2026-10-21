import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { transaction, type Db } from '../../db/database.js';
import type { RepoRow } from '../../db/repo-store.js';
import type { RepoRef } from '../../domain/repo-ref.js';
import { isBotIdentity, isGeneratedPath, loginFromNoreply, prNumberFromSubject } from '../path-filters.js';
import { runGit, streamGitLines, type GitOptions } from './git-runner.js';
import { LOG_FORMAT, LogParser, type ParsedCommit, type Person } from './log-parser.js';

export interface GitSourceOptions {
  dataDir: string;
  timeoutMs: number;
  /** Upper bound on commits ingested per sync; protects memory on extremely active repos. */
  maxCommits?: number;
  /** Builds the clone URL. Production: fixed https://github.com host. Tests: file:// fixtures. */
  remoteUrl?: (ref: RepoRef) => string;
  allowFileProtocol?: boolean;
}

export interface GitSyncResult {
  branch: string;
  headSha: string;
  changed: boolean;
  commits: number;
  boundaryCommits: number;
  durationMs: number;
}

export const githubRemoteUrl = (ref: RepoRef): string =>
  `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}.git`;

const DEFAULT_MAX_COMMITS = 50_000;

export class GitSource {
  private readonly remoteUrl: (ref: RepoRef) => string;

  constructor(
    private readonly db: Db,
    private readonly opts: GitSourceOptions,
  ) {
    this.remoteUrl = opts.remoteUrl ?? githubRemoteUrl;
  }

  mirrorPath(ref: RepoRef): string {
    return join(this.opts.dataDir, 'git', ref.owner.toLowerCase(), `${ref.name.toLowerCase()}.git`);
  }

  async sync(repo: RepoRow, horizon: number, signal?: AbortSignal): Promise<GitSyncResult> {
    const started = Date.now();
    const ref = { owner: repo.owner, name: repo.name };
    const dir = this.mirrorPath(ref);
    const git: GitOptions = { timeoutMs: this.opts.timeoutMs, allowFileProtocol: this.opts.allowFileProtocol, signal };
    const since = new Date(horizon).toISOString();

    if (existsSync(join(dir, 'HEAD'))) {
      await runGit(['fetch', '--prune', '--no-tags', `--shallow-since=${since}`, 'origin'], { ...git, cwd: dir });
    } else {
      await this.cloneAtomically(ref, dir, since, git);
    }

    const branch = (await runGit(['symbolic-ref', '--short', 'HEAD'], { ...git, cwd: dir })).trim();
    const headSha = (await runGit(['rev-parse', `refs/heads/${branch}`], { ...git, cwd: dir })).trim();

    // Nothing new upstream and the horizon has not moved by a day: skip the re-ingest.
    const horizonMoved = repo.horizon === null || Math.abs(horizon - repo.horizon) > 86_400_000;
    if (headSha === repo.head_sha && !horizonMoved) {
      return { branch, headSha, changed: false, commits: 0, boundaryCommits: 0, durationMs: Date.now() - started };
    }

    const boundary = readShallowBoundary(dir);
    const commits: ParsedCommit[] = [];
    const max = this.opts.maxCommits ?? DEFAULT_MAX_COMMITS;
    const parser = new LogParser((c) => {
      if (commits.length >= max) {
        throw new Error(`more than ${max} commits within the lookback window; lower SYNC_LOOKBACK_DAYS for this repo`);
      }
      commits.push(c);
    });
    await streamGitLines(
      ['-c', 'core.quotepath=false', 'log', `refs/heads/${branch}`, '--numstat', `--format=${LOG_FORMAT}`, `--since=${since}`],
      { ...git, cwd: dir },
      (line) => parser.push(line),
    );
    parser.end();

    const boundaryCommits = this.replaceHistory(repo.id, commits, boundary);
    return { branch, headSha, changed: true, commits: commits.length, boundaryCommits, durationMs: Date.now() - started };
  }

  /** Clones into a temp dir and renames, so a crash never leaves a half-cloned mirror in place. */
  private async cloneAtomically(ref: RepoRef, dir: string, since: string, git: GitOptions): Promise<void> {
    await mkdir(dirname(dir), { recursive: true });
    const tmp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await runGit(
        ['clone', '--bare', '--single-branch', '--no-tags', `--shallow-since=${since}`, '--', this.remoteUrl(ref), tmp],
        git,
      );
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Atomically replaces the repo's commit history with `commits`. Returns the number of
   * shallow-boundary commits, whose line stats are unknowable from the clone and so are
   * stored as incomplete instead of as "added the whole tree".
   */
  private replaceHistory(repoId: number, commits: ParsedCommit[], boundary: Set<string>): number {
    let boundaryCount = 0;
    transaction(this.db, () => {
      for (const table of ['co_authors', 'file_changes', 'commits']) {
        this.db.prepare(`DELETE FROM ${table} WHERE repo_id = ?`).run(repoId);
      }
      const authors = new AuthorResolver(this.db, repoId);
      const insertCommit = this.db.prepare(
        `INSERT INTO commits (repo_id, sha, author_id, committed_at, authored_at, author_tz_min, additions, deletions,
           churn, files_changed, is_merge, pr_number, stats_complete) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertFile = this.db.prepare(
        'INSERT INTO file_changes (repo_id, sha, path, additions, deletions, generated) VALUES (?,?,?,?,?,?)',
      );
      const insertCoAuthor = this.db.prepare('INSERT OR IGNORE INTO co_authors (repo_id, sha, author_id) VALUES (?,?,?)');

      for (const c of commits) {
        const authorId = authors.resolve(c.author);
        const isMerge = c.parents.length > 1;
        const complete = !boundary.has(c.sha);
        if (!complete) boundaryCount++;
        let additions = 0;
        let deletions = 0;
        if (complete && !isMerge) {
          for (const f of c.files) {
            const generated = isGeneratedPath(f.path);
            insertFile.run(repoId, c.sha, f.path, f.additions ?? 0, f.deletions ?? 0, generated ? 1 : 0);
            if (!generated) {
              additions += f.additions ?? 0;
              deletions += f.deletions ?? 0;
            }
          }
        }
        insertCommit.run(
          repoId,
          c.sha,
          authorId,
          c.committedAt,
          c.authoredAt,
          c.authorTzMin,
          additions,
          deletions,
          additions + deletions,
          complete && !isMerge ? c.files.length : 0,
          isMerge ? 1 : 0,
          prNumberFromSubject(c.subject),
          complete ? 1 : 0,
        );
        for (const co of c.coAuthors) {
          const coId = authors.resolve(co);
          if (coId !== authorId) insertCoAuthor.run(repoId, c.sha, coId);
        }
      }
    });
    return boundaryCount;
  }
}

/** Maps (mailmapped) identities to author rows; the first name seen (newest commit) wins. */
class AuthorResolver {
  private readonly cache = new Map<string, number>();
  private readonly upsert;

  constructor(
    db: Db,
    private readonly repoId: number,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO authors (repo_id, key, public_id, name, login, is_bot) VALUES (?,?,?,?,?,?)
       ON CONFLICT (repo_id, key) DO UPDATE SET name = excluded.name, login = COALESCE(excluded.login, authors.login),
         is_bot = excluded.is_bot
       RETURNING id`,
    );
  }

  resolve(person: Person): number {
    const key = person.email.trim().toLowerCase() || `name:${person.name.trim().toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const login = loginFromNoreply(key);
    const row = this.upsert.get(
      this.repoId,
      key,
      publicAuthorId(key),
      person.name.trim() || login || 'unknown',
      login,
      isBotIdentity(person.name, login ?? key) ? 1 : 0,
    ) as { id: number };
    this.cache.set(key, row.id);
    return row.id;
  }
}

/** Stable, non-reversible id for an author; e-mail addresses are never exposed by the API. */
export function publicAuthorId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function readShallowBoundary(dir: string): Set<string> {
  const file = join(dir, 'shallow');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
}
