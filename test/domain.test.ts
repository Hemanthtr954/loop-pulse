import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { AppError } from '../src/domain/errors.js';
import { previousPeriod, resolvePeriod } from '../src/domain/period.js';
import { parseRepoRef } from '../src/domain/repo-ref.js';
import { githubRemoteUrl } from '../src/ingest/git/git-source.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');

describe('repo references (the SSRF / injection boundary)', () => {
  it('accepts valid GitHub names', () => {
    expect(parseRepoRef('fastify/fastify')).toEqual({ owner: 'fastify', name: 'fastify' });
    expect(parseRepoRef('a-b/c.d_e-f')).toEqual({ owner: 'a-b', name: 'c.d_e-f' });
  });

  it.each([
    'https://evil.example/x',
    'owner/name/extra',
    '../etc/passwd',
    'owner/..',
    'owner/.',
    '-owner/name',
    'own--er/name',
    'owner/name;rm -rf /',
    'owner/name.git',
    'owner/na me',
    'owner/$(id)',
    '/name',
    'owner/',
    `${'a'.repeat(40)}/x`,
  ])('rejects %s', (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });

  it('only ever builds github.com URLs', () => {
    expect(githubRemoteUrl({ owner: 'a', name: 'b' })).toBe('https://github.com/a/b.git');
  });
});

describe('resolvePeriod', () => {
  it('defaults to the 90 days ending at the start of tomorrow (UTC)', () => {
    const p = resolvePeriod({}, NOW);
    expect(new Date(p.to).toISOString()).toBe('2026-06-16T00:00:00.000Z');
    expect(new Date(p.from).toISOString()).toBe('2026-03-18T00:00:00.000Z');
  });

  it('accepts dates and datetimes with offsets', () => {
    const p = resolvePeriod({ from: '2026-01-01', to: '2026-02-01T05:00:00+05:00' }, NOW);
    expect(p).toEqual({ from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-02-01T00:00:00Z') });
  });

  const invalid = (input: { from?: string; to?: string }) => {
    try {
      resolvePeriod(input, NOW);
    } catch (e) {
      return e instanceof AppError ? e.status : -1;
    }
    return 0;
  };

  it.each([
    [{ from: '2026-02-30' }],
    [{ from: 'yesterday' }],
    [{ from: '2026-01-01T00:00:00' }], // no offset: ambiguous
    [{ from: '2026-03-01', to: '2026-02-01' }],
    [{ from: '2024-01-01', to: '2026-01-01' }], // > 366 days
    [{ from: '2027-01-01', to: '2027-02-01' }], // future
  ])('rejects %j with 400', (input) => {
    expect(invalid(input)).toBe(400);
  });

  it('computes the previous period of equal length', () => {
    expect(previousPeriod({ from: 100, to: 150 })).toEqual({ from: 50, to: 100 });
  });
});

describe('loadConfig', () => {
  it('parses defaults and lists', () => {
    const c = loadConfig({ TRACKED_REPOS: 'a/b, c/d', CORS_ORIGINS: 'https://x.io' });
    expect(c.repos.tracked).toEqual([
      { owner: 'a', name: 'b' },
      { owner: 'c', name: 'd' },
    ]);
    expect(c.llm.provider).toBe('rules');
    expect(c.corsOrigins).toEqual(['https://x.io']);
  });

  it('picks an LLM provider from the available key', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k' }).llm.provider).toBe('anthropic');
    expect(loadConfig({ OPENAI_API_KEY: 'k' }).llm.provider).toBe('openai');
  });

  it.each([{ PORT: 'abc' }, { TRACKED_REPOS: 'not a repo' }, { LLM_PROVIDER: 'anthropic' }, { SYNC_LOOKBACK_DAYS: '5' }])(
    'fails fast with a readable message for %j',
    (env) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );
});
