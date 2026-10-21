import type { FastifyInstance } from 'fastify';
import type { RepoRow } from '../../db/repo-store.js';
import { AppError } from '../../domain/errors.js';
import { makeRepoRef, repoKey } from '../../domain/repo-ref.js';
import { apiKeyGuard, requireRepo, type AppDeps } from '../context.js';
import { RegisterRepoBody } from '../schemas.js';
import { parse, repoFromParams } from '../validation.js';

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export function repoView(deps: AppDeps, r: RepoRow) {
  const base = `/v1/repos/${r.owner}/${r.name}`;
  return {
    owner: r.owner,
    name: r.name,
    slug: `${r.owner}/${r.name}`,
    defaultBranch: r.default_branch,
    sync: {
      status: r.sync_status,
      inProgress: deps.sync.isSyncing(r.id),
      error: r.sync_error,
      lastSyncedAt: iso(r.last_synced_at),
    },
    history: { availableFrom: iso(r.horizon), headSha: r.head_sha, dataVersion: r.data_version },
    github: { enabled: deps.sync.githubEnabled, status: r.github_status, lastSyncedAt: iso(r.github_synced_at) },
    links: {
      self: base,
      contributors: `${base}/insights/contributors`,
      knowledgeRisk: `${base}/insights/knowledge-risk`,
      activity: `${base}/insights/activity`,
      reviewers: `${base}/insights/reviewers`,
      flow: `${base}/insights/flow`,
      narrative: `${base}/narrative`,
    },
  };
}

export async function repoRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const guard = apiKeyGuard(deps.config.apiKey);
  const writeLimit = { rateLimit: { max: 5, timeWindow: '1 minute' } };

  app.get('/v1/repos', async () => ({ items: deps.repos.list().map((r) => repoView(deps, r)) }));

  app.get('/v1/repos/:owner/:name', async (req) => repoView(deps, requireRepo(deps, repoFromParams(req.params))));

  app.post('/v1/repos', { preHandler: guard, config: writeLimit }, async (req, reply) => {
    const body = parse(RegisterRepoBody, req.body, 'body');
    const ref = makeRepoRef(body.owner, body.name);
    if (!ref) throw AppError.badRequest('Invalid repository', [{ field: 'owner/name', message: 'must be a valid GitHub owner and repository name' }]);

    const existing = deps.repos.find(ref);
    if (existing) return reply.status(200).send(repoView(deps, existing));

    const { repos } = deps.config;
    const allowed = [...repos.tracked, ...repos.allowed].some((r) => repoKey(r) === repoKey(ref));
    if (!repos.allowAnyPublic && !allowed) {
      throw AppError.forbidden('This repository is not on the allowlist. Add it to ALLOWED_REPOS or set ALLOW_ANY_PUBLIC_REPO=true.');
    }
    if (deps.repos.count() >= repos.max) {
      throw AppError.conflict('repo-limit', 'Repository limit reached', `At most ${repos.max} repositories can be registered (MAX_REPOS).`);
    }
    const { row } = deps.repos.ensure(ref, deps.now());
    void deps.sync.sync(row.id);
    return reply.status(202).header('location', `/v1/repos/${row.owner}/${row.name}`).send(repoView(deps, deps.repos.get(row.id)));
  });

  app.post('/v1/repos/:owner/:name/sync', { preHandler: guard, config: writeLimit }, async (req, reply) => {
    const repo = requireRepo(deps, repoFromParams(req.params));
    void deps.sync.sync(repo.id);
    return reply.status(202).header('location', `/v1/repos/${repo.owner}/${repo.name}`).send(repoView(deps, deps.repos.get(repo.id)));
  });
}
