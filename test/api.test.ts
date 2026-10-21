import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED, PERIOD } from './helpers/fixture-repo.js';
import { buildTestApp } from './helpers/setup.js';

const q = `from=${PERIOD.from}&to=${PERIOD.to}`;

describe('HTTP API', async () => {
  const { app, repos, repoId, db } = await buildTestApp({ env: { API_KEY: 'test-key', ALLOWED_REPOS: 'acme/other' } });
  afterAll(() => app.close());

  it('serves liveness, readiness and the OpenAPI document', async () => {
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).json()).toEqual({ status: 'ready' });
    const doc = (await app.inject('/openapi.json')).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/repos/{owner}/{name}/narrative');
    const params = doc.paths['/v1/repos/{owner}/{name}/insights/contributors'].get.parameters.map((p: { name: string }) => p.name);
    expect(params).toEqual(expect.arrayContaining(['from', 'to', 'sort', 'limit', 'includeBots']));
  });

  it('returns contributors with meta, definitions and totals that add up', async () => {
    const res = await app.inject(`/v1/repos/acme/widgets/insights/contributors?${q}&sort=churn&limit=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ repo: 'acme/widgets', period: { days: 92 }, dataVersion: 1 });
    expect(body.meta.definitions.churn).toMatch(/generated/);
    expect(body.data.totals.commits).toBe(EXPECTED.commits);
    expect(body.data.items.map((c: { name: string }) => c.name)).toEqual(['Carol Poe', 'Alice Doe']);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
  });

  it('supports conditional requests with a weak ETag', async () => {
    const url = `/v1/repos/acme/widgets/insights/knowledge-risk?${q}`;
    const first = await app.inject(url);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const second = await app.inject({ url, headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    // Different query → different ETag.
    const other = await app.inject(`/v1/repos/acme/widgets/insights/knowledge-risk?${q}&includeBots=true`);
    expect(other.headers.etag).not.toBe(etag);
  });

  it('answers activity with a weekly series and a narrative with an evidence chain', async () => {
    const activity = (await app.inject(`/v1/repos/acme/widgets/insights/activity?${q}`)).json();
    expect(activity.data.weeks[0].weekStart).toBe('2026-02-23');
    const narrative = (await app.inject(`/v1/repos/acme/widgets/narrative?${q}`)).json();
    expect(narrative.generation).toMatchObject({ provider: 'rules', degraded: false });
    for (const f of narrative.narrative.findings) for (const id of f.evidence) expect(narrative.evidence[id]).toBeDefined();
    const again = (await app.inject(`/v1/repos/acme/widgets/narrative?${q}`)).json();
    expect(again.generation.cached).toBe(true);
  });

  it.each([
    [`/v1/repos/acme/widgets/insights/contributors?from=nope`, 400, 'invalid-request'],
    [`/v1/repos/acme/widgets/insights/contributors?${q}&limit=1000`, 400, 'invalid-request'],
    [`/v1/repos/acme/widgets/insights/contributors?${q}&unknown=1`, 400, 'invalid-request'],
    [`/v1/repos/acme/widgets/insights/contributors?from=2024-01-01&to=2024-06-01`, 422, 'period-out-of-range'],
    [`/v1/repos/acme/nope/insights/contributors`, 404, 'not-found'],
    [`/v1/repos/bad..owner/x/insights/contributors`, 400, 'invalid-request'],
    [`/v1/repos/acme/widgets/insights/reviewers?${q}`, 409, 'source-not-configured'],
    [`/v1/nothing-here`, 404, 'not-found'],
  ])('GET %s → %i %s (problem+json)', async (url, status, type) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ type: `/problems/${type}`, status });
  });

  it('includes per-field errors on 400', async () => {
    const res = await app.inject(`/v1/repos/acme/widgets/insights/contributors?from=2026-02-30`);
    expect(res.json().errors).toEqual([{ field: 'from', message: expect.stringMatching(/YYYY-MM-DD/) }]);
  });

  it('answers 409 with Retry-After while the first sync is running', async () => {
    const { row } = repos.ensure({ owner: 'acme', name: 'pending' }, Date.now());
    db.prepare("UPDATE repos SET sync_status = 'syncing' WHERE id = ?").run(row.id);
    const res = await app.inject(`/v1/repos/acme/pending/insights/activity`);
    expect(res.statusCode).toBe(409);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toMatchObject({ type: '/problems/repo-not-ready', syncStatus: 'syncing' });
  });

  it('protects writes with the API key and enforces the allowlist', async () => {
    const body = { owner: 'acme', name: 'other' };
    expect((await app.inject({ method: 'POST', url: '/v1/repos', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/repos', payload: body, headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(401);

    const forbidden = await app.inject({ method: 'POST', url: '/v1/repos', payload: { owner: 'evil', name: 'repo' }, headers: { 'x-api-key': 'test-key' } });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await app.inject({ method: 'POST', url: '/v1/repos', payload: { owner: 'acme', name: '../x' }, headers: { 'x-api-key': 'test-key' } });
    expect(invalid.statusCode).toBe(400);

    const existing = await app.inject({ method: 'POST', url: '/v1/repos', payload: { owner: 'acme', name: 'widgets' }, headers: { 'x-api-key': 'test-key' } });
    expect(existing.statusCode).toBe(200);
    expect(repos.get(repoId).owner).toBe('acme');
  });

  it('rejects oversized and malformed bodies', async () => {
    // A different client address, so the write rate limit used up above does not interfere.
    const remoteAddress = '10.9.9.9';
    const big = await app.inject({ method: 'POST', url: '/v1/repos', remoteAddress, payload: 'x'.repeat(20_000), headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' } });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({ method: 'POST', url: '/v1/repos', remoteAddress, payload: '{nope', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().type).toBe('/problems/invalid-request');
  });
});
