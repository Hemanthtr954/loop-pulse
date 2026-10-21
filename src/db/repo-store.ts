import type { Db } from './database.js';
import { repoKey, type RepoRef } from '../domain/repo-ref.js';

export type SyncStatus = 'pending' | 'syncing' | 'ready' | 'error';

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  default_branch: string | null;
  created_at: number;
  sync_status: SyncStatus;
  sync_error: string | null;
  last_synced_at: number | null;
  horizon: number | null;
  head_sha: string | null;
  data_version: number;
  github_cursor: number | null;
  github_status: string | null;
  github_etag: string | null;
  github_synced_at: number | null;
}

export class RepoStore {
  constructor(private readonly db: Db) {}

  list(): RepoRow[] {
    return this.db.prepare('SELECT * FROM repos ORDER BY owner, name').all() as unknown as RepoRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM repos').get() as { n: number }).n;
  }

  find(ref: RepoRef): RepoRow | undefined {
    return this.db.prepare('SELECT * FROM repos WHERE slug_key = ?').get(repoKey(ref)) as RepoRow | undefined;
  }

  get(id: number): RepoRow {
    const row = this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
    if (!row) throw new Error(`repo ${id} not found`);
    return row;
  }

  /** Inserts if missing; returns the row and whether it was created. */
  ensure(ref: RepoRef, now: number): { row: RepoRow; created: boolean } {
    const existing = this.find(ref);
    if (existing) return { row: existing, created: false };
    this.db
      .prepare('INSERT INTO repos (owner, name, slug_key, created_at) VALUES (?, ?, ?, ?)')
      .run(ref.owner, ref.name, repoKey(ref), now);
    return { row: this.find(ref)!, created: true };
  }

  markSyncing(id: number): void {
    this.db.prepare("UPDATE repos SET sync_status = 'syncing' WHERE id = ?").run(id);
  }

  markReady(id: number, fields: { branch: string; headSha: string; horizon: number; changed: boolean; now: number }): void {
    this.db
      .prepare(
        `UPDATE repos SET sync_status = 'ready', sync_error = NULL, default_branch = ?, head_sha = ?, horizon = ?,
           last_synced_at = ?, data_version = data_version + ? WHERE id = ?`,
      )
      .run(fields.branch, fields.headSha, fields.horizon, fields.now, fields.changed ? 1 : 0, id);
  }

  /**
   * A failed sync keeps previously ingested data queryable: if the repo was ready before, it
   * stays ready (with the error recorded); otherwise it moves to 'error'.
   */
  markFailed(id: number, message: string): void {
    this.db
      .prepare(
        `UPDATE repos SET sync_error = ?, sync_status = CASE WHEN head_sha IS NULL THEN 'error' ELSE 'ready' END WHERE id = ?`,
      )
      .run(message.slice(0, 500), id);
  }

  recordGithub(
    id: number,
    fields: { cursor: number | null; etag: string | null; status: string; changed: boolean; now: number },
  ): void {
    this.db
      .prepare(
        `UPDATE repos SET github_cursor = COALESCE(?, github_cursor), github_etag = COALESCE(?, github_etag),
           github_status = ?, github_synced_at = ?, data_version = data_version + ? WHERE id = ?`,
      )
      .run(fields.cursor, fields.etag, fields.status, fields.now, fields.changed ? 1 : 0, id);
  }
}
