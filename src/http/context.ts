import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { RepoRow, RepoStore } from '../db/repo-store.js';
import { AppError } from '../domain/errors.js';
import type { RepoRef } from '../domain/repo-ref.js';
import type { SyncService } from '../ingest/sync-service.js';
import type { InsightService } from '../insights/insight-service.js';
import type { NarrativeService } from '../narrative/narrative-service.js';

export interface AppDeps {
  config: Config;
  db: Db;
  repos: RepoStore;
  sync: SyncService;
  insights: InsightService;
  narrative: NarrativeService;
  now: () => number;
}

export function requireRepo(deps: AppDeps, ref: RepoRef): RepoRow {
  const repo = deps.repos.find(ref);
  if (!repo) throw AppError.notFound(`Repository ${ref.owner}/${ref.name} is not registered. POST /v1/repos to add it.`);
  return repo;
}

/** preHandler for mutating routes: constant-time API key check when API_KEY is configured. */
export function apiKeyGuard(expected: string | undefined) {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const want = expected ? digest(expected) : null;
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!want) return;
    const got = req.headers['x-api-key'];
    if (typeof got !== 'string' || !timingSafeEqual(digest(got), want)) throw AppError.unauthorized();
  };
}

/** Weak ETag over the inputs that fully determine a response body. */
export function etagFor(...parts: (string | number | boolean)[]): string {
  return `W/"${createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 27)}"`;
}

export function notModified(req: FastifyRequest, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header.split(',').some((t) => t.trim() === etag || t.trim() === '*');
}
