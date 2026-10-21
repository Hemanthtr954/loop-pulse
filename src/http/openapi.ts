import { z } from 'zod';
import { ActivityQuery, ContributorsQuery, FlowQuery, KnowledgeRiskQuery, NarrativeQuery, RegisterRepoBody, ReviewersQuery } from './schemas.js';

/**
 * OpenAPI 3.1 document. Query parameters and request bodies are generated from the same Zod
 * schemas the handlers validate with, so the contract cannot drift from the implementation.
 */
function queryParams(schema: z.ZodObject) {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    description: typeof s.description === 'string' ? s.description : undefined,
    schema: s,
  }));
}

const repoParams = [
  { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
];

const problem = { description: 'Problem (RFC 9457)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
const ok = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });

function insight(summary: string, schema: z.ZodObject, extra: Record<string, unknown> = {}) {
  return {
    get: {
      summary,
      parameters: [...repoParams, ...queryParams(schema)],
      responses: {
        200: ok('`{ meta, data }`'),
        304: { description: 'Not modified (If-None-Match matched the ETag)' },
        400: problem,
        404: problem,
        409: problem,
        422: problem,
        ...extra,
      },
    },
  };
}

export function buildOpenApi(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Loop Pulse API',
      version,
      description:
        'Engineering insights from git history (and optionally GitHub pull requests): contributors, knowledge risk, activity, review load and flow, plus an evidence-checked narrative.',
    },
    paths: {
      '/healthz': { get: { summary: 'Liveness', responses: { 200: ok('ok') } } },
      '/readyz': { get: { summary: 'Readiness (database reachable)', responses: { 200: ok('ready'), 503: problem } } },
      '/v1/repos': {
        get: { summary: 'List registered repositories and their sync state', responses: { 200: ok('Repositories') } },
        post: {
          summary: 'Register a repository and start syncing it',
          security: [{ apiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(RegisterRepoBody, { target: 'openapi-3.0' }) } } },
          responses: { 200: ok('Already registered'), 202: ok('Registered; sync started'), 400: problem, 401: problem, 403: problem, 409: problem, 429: problem },
        },
      },
      '/v1/repos/{owner}/{name}': { get: { summary: 'One repository', parameters: repoParams, responses: { 200: ok('Repository'), 404: problem } } },
      '/v1/repos/{owner}/{name}/sync': {
        post: { summary: 'Trigger a refresh', security: [{ apiKey: [] }], parameters: repoParams, responses: { 202: ok('Sync started'), 401: problem, 404: problem, 429: problem } },
      },
      '/v1/repos/{owner}/{name}/insights/contributors': insight('Top contributors by commits, churn, files or merged PRs', ContributorsQuery),
      '/v1/repos/{owner}/{name}/insights/knowledge-risk': insight('Truck factor, ownership concentration, hotspots and areas', KnowledgeRiskQuery),
      '/v1/repos/{owner}/{name}/insights/activity': insight('Weekly activity and comparison with the previous period', ActivityQuery),
      '/v1/repos/{owner}/{name}/insights/reviewers': insight('Top reviewers and review load balance (needs GITHUB_TOKEN)', ReviewersQuery),
      '/v1/repos/{owner}/{name}/insights/flow': insight('Time to merge, time to first review, unreviewed merges, stale PRs (needs GITHUB_TOKEN)', FlowQuery),
      '/v1/repos/{owner}/{name}/narrative': {
        get: {
          summary: 'Evidence-checked narrative with hypothesis, calibrated confidence and evidence chain',
          parameters: [...repoParams, ...queryParams(NarrativeQuery)],
          responses: { 200: ok('Narrative'), 400: problem, 404: problem, 409: problem, 422: problem, 429: problem },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' },
            requestId: { type: 'string' },
          },
        },
      },
    },
  };
}
