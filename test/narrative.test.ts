import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../src/domain/period.js';
import { assembleInput, generateGuarded, type BuiltInput } from '../src/narrative/narrative-service.js';
import { RulesProvider } from '../src/narrative/providers/rules.js';
import type { NarrativeProvider } from '../src/narrative/providers/types.js';
import { FIXTURE_NOW, PERIOD } from './helpers/fixture-repo.js';
import { ingestFixture, silentLog } from './helpers/setup.js';

class ScriptedProvider implements NarrativeProvider {
  readonly name = 'scripted';
  readonly model = 'test';
  calls: (string[] | undefined)[] = [];
  constructor(private readonly replies: ((b: BuiltInput) => unknown)[], private readonly built: BuiltInput) {}
  async generate(_input: unknown, notes?: string[]) {
    this.calls.push(notes);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    return reply(this.built);
  }
}

const valid = (b: BuiltInput) => {
  const commits = b.facts.find((f) => f.key === 'totals.commits')!;
  return {
    headline: 'A small, steady repository',
    summary: commits.statement,
    findings: [{ claim: commits.statement, evidence: [commits.id] }],
    hypothesis: { statement: 'Work is likely driven by a small core team.', evidence: [commits.id], confidence: 0.95 },
    confidence: 0.99,
    caveats: [],
  };
};
const hallucinated = (b: BuiltInput) => ({ ...valid(b), summary: 'Exactly 4242 commits landed.' });
const fabricated = (b: BuiltInput) => ({ ...valid(b), findings: [{ claim: 'Something.', evidence: ['F999'] }] });

describe('generateGuarded', async () => {
  const h = await ingestFixture();
  const repo = h.repos.get(h.repoId);
  const period = resolvePeriod(PERIOD, FIXTURE_NOW);
  const built = assembleInput(
    {
      repo: 'acme/widgets',
      period: { from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString(), days: 92 },
      contributors: h.insights.contributors(repo, period, false),
      knowledgeRisk: h.insights.knowledgeRisk(repo, period, false),
      activity: h.insights.activity(repo, period, false),
      reviewers: null,
      flow: null,
    },
    '/v1/repos/acme/widgets/insights',
    'from=a&to=b',
  );
  const rules = new RulesProvider();

  it('returns a valid model draft and caps its confidence by data sufficiency', async () => {
    const r = await generateGuarded(new ScriptedProvider([valid], built), rules, built, silentLog);
    expect(r.generation).toMatchObject({ provider: 'scripted', degraded: false, attempts: 1 });
    // 7 commits from 3 authors: far too little data for 0.99.
    expect(r.confidence.model).toBe(0.99);
    expect(r.confidence.value).toBeLessThan(0.6);
    expect(r.confidence.value).toBe(built.input.confidenceCeiling);
    // No causal signal behind this hypothesis → capped at 0.5 at most.
    expect(r.narrative.hypothesis!.confidence).toBeLessThanOrEqual(0.5);
    // The evidence chain resolves each cited id to its statement and source.
    const [id] = r.narrative.findings[0]!.evidence;
    expect(r.evidence[id!]).toMatchObject({ key: 'totals.commits', source: { pointer: '/data/totals/commits' } });
  });

  it('gives the model one repair attempt with the violations', async () => {
    const p = new ScriptedProvider([hallucinated, valid], built);
    const r = await generateGuarded(p, rules, built, silentLog);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.join()).toMatch(/4242/);
    expect(r.generation).toMatchObject({ provider: 'scripted', attempts: 2, degraded: false });
  });

  it.each([
    ['hallucinates a number', hallucinated],
    ['cites a fact that does not exist', fabricated],
  ])('never returns a draft that %s; it degrades to the rules narrator', async (_label, reply) => {
    const r = await generateGuarded(new ScriptedProvider([reply], built), rules, built, silentLog);
    expect(r.generation.provider).toBe('rules');
    expect(r.generation.degraded).toBe(true);
    expect(r.generation.degradedReason).toMatch(/validation failed/);
    expect(JSON.stringify(r.narrative)).not.toMatch(/4242|F999/);
  });

  it('degrades immediately on provider errors without a repair loop', async () => {
    const failing: NarrativeProvider = {
      name: 'down',
      model: 'x',
      generate: async () => {
        throw new Error('HTTP 503');
      },
    };
    const r = await generateGuarded(failing, rules, built, silentLog);
    expect(r.generation).toMatchObject({ provider: 'rules', degraded: true, attempts: 2 });
    expect(r.generation.degradedReason).toMatch(/503/);
  });

  it('the rules narrator always passes its own guard and cites only real facts', async () => {
    const r = await generateGuarded(rules, rules, built, silentLog);
    const ids = new Set(built.facts.map((f) => f.id));
    for (const f of r.narrative.findings) for (const id of f.evidence) expect(ids.has(id)).toBe(true);
    expect(r.narrative.caveats.join()).toMatch(/Small sample/);
  });
});
