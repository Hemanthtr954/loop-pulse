import type { FastifyInstance } from 'fastify';
import { periodToJson, resolvePeriod } from '../../domain/period.js';
import { requireRepo, type AppDeps } from '../context.js';
import { NarrativeQuery } from '../schemas.js';
import { parse, repoFromParams } from '../validation.js';
import { canonicalQuery } from './insights.js';

export async function narrativeRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get(
    '/v1/repos/:owner/:name/narrative',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const repo = requireRepo(deps, repoFromParams(req.params));
      const q = parse(NarrativeQuery, req.query, 'query');
      const period = resolvePeriod(q, deps.now());
      deps.insights.assertQueryable(repo, period);

      const base = `/v1/repos/${repo.owner}/${repo.name}/insights`;
      const query = canonicalQuery(period);
      const result = await deps.narrative.narrate(repo, period, base, query);
      reply.header('cache-control', 'private, max-age=60');
      return {
        meta: {
          repo: `${repo.owner}/${repo.name}`,
          period: periodToJson(period),
          query,
          dataVersion: repo.data_version,
          generatedAt: new Date(deps.now()).toISOString(),
        },
        ...result,
      };
    },
  );
}
