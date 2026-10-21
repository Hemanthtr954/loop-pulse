import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { RepoRow } from '../../db/repo-store.js';
import { AppError } from '../../domain/errors.js';
import { periodToJson, resolvePeriod, type Period } from '../../domain/period.js';
import { rankContributors } from '../../insights/contributors.js';
import { DEFINITIONS, type InsightKind } from '../../insights/definitions.js';
import { etagFor, notModified, requireRepo, type AppDeps } from '../context.js';
import { ActivityQuery, ContributorsQuery, FlowQuery, KnowledgeRiskQuery, ReviewersQuery } from '../schemas.js';
import { parse, repoFromParams } from '../validation.js';

interface Resolved<Q> {
  repo: RepoRow;
  period: Period;
  q: Q;
}

/** `from`/`to` as resolved ISO instants plus the other params, in a stable order. */
export function canonicalQuery(period: Period, extra: Record<string, string | number | boolean> = {}): string {
  const params = new URLSearchParams({ from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString() });
  for (const [k, v] of Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))) params.set(k, String(v));
  return params.toString();
}

export async function insightRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Shared handler shape: validate → resolve period → readiness/horizon checks → ETag check
   * (before any computation, so a 304 is nearly free) → compute → { meta, data }.
   */
  function route<S extends z.ZodType<{ from?: string | undefined; to?: string | undefined; includeBots?: boolean }>>(
    kind: InsightKind,
    schema: S,
    compute: (r: Resolved<z.infer<S>>) => unknown,
    opts: { needsGithub?: boolean; volatileDaily?: boolean } = {},
  ) {
    app.get(`/v1/repos/:owner/:name/insights/${kind}`, async (req: FastifyRequest, reply: FastifyReply) => {
      const repo = requireRepo(deps, repoFromParams(req.params));
      const q = parse(schema, req.query, 'query') as z.infer<S>;
      const period = resolvePeriod(q, deps.now());
      deps.insights.assertQueryable(repo, period);
      if (opts.needsGithub && !deps.sync.githubEnabled) {
        throw AppError.conflict(
          'source-not-configured',
          'Pull request data not configured',
          'This insight needs GitHub pull request data. Set GITHUB_TOKEN (read-only, public repositories) and restart.',
        );
      }

      const { from: _f, to: _t, ...rest } = q as Record<string, unknown>;
      const query = canonicalQuery(period, rest as Record<string, string | number | boolean>);
      const day = opts.volatileDaily ? Math.floor(deps.now() / 86_400_000) : 0;
      const etag = etagFor(kind, repo.id, repo.data_version, query, day);
      reply.header('etag', etag).header('cache-control', 'private, max-age=60');
      if (notModified(req, etag)) return reply.status(304).send();

      return {
        meta: {
          repo: `${repo.owner}/${repo.name}`,
          period: periodToJson(period),
          query,
          dataVersion: repo.data_version,
          historyAvailableFrom: new Date(repo.horizon!).toISOString(),
          generatedAt: new Date(deps.now()).toISOString(),
          definitions: DEFINITIONS[kind],
        },
        data: compute({ repo, period, q }),
      };
    });
  }

  route('contributors', ContributorsQuery, ({ repo, period, q }) => {
    const result = deps.insights.contributors(repo, period, q.includeBots);
    return { totals: result.totals, items: rankContributors(result.items, q.sort, q.limit) };
  });

  route('knowledge-risk', KnowledgeRiskQuery, ({ repo, period, q }) => {
    const r = deps.insights.knowledgeRisk(repo, period, q.includeBots);
    return { ...r, hotspots: r.hotspots.slice(0, q.limit), areas: r.areas.slice(0, q.limit) };
  });

  route('activity', ActivityQuery, ({ repo, period, q }) => deps.insights.activity(repo, period, q.includeBots));

  route('reviewers', ReviewersQuery, ({ repo, period, q }) => deps.insights.reviewers(repo, period, q.includeBots, q.limit), {
    needsGithub: true,
  });

  route('flow', FlowQuery, ({ repo, period, q }) => deps.insights.flow(repo, period, q.includeBots), {
    needsGithub: true,
    volatileDaily: true,
  });
}
