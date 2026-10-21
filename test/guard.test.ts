import { describe, expect, it } from 'vitest';
import type { Fact } from '../src/narrative/facts.js';
import { extractNumbers, guardDraft } from '../src/narrative/guard.js';

const fact = (id: string, key: string, value: number, unit: Fact['unit'], statement: string): Fact => ({
  id,
  key,
  value,
  unit,
  statement,
  source: { path: '/x', pointer: '/data/x' },
});

const FACTS: Fact[] = [
  fact('F1', 'period.days', 90, 'days', 'The period covers 90 days between 2026-03-01 and 2026-05-30.'),
  fact('F2', 'totals.commits', 1234, 'count', '1234 non-merge commits landed on the default branch.'),
  fact('F3', 'risk.topShare', 0.4123, 'ratio', 'Ann wrote 41.2% of all churn.'),
  fact('F4', 'risk.truckFactor', 1, 'people', 'The truck factor is 1: losing Ann would leave most of the 80 changed files without anyone who recently worked on them.'),
];

const draft = (over: Record<string, unknown> = {}) => ({
  headline: 'Knowledge rests on one person',
  summary: 'Over 90 days, 1,234 commits landed and Ann wrote 41.2% of churn.',
  findings: [
    { claim: 'Ann wrote 41% of all churn.', evidence: ['F3'] },
    { claim: 'The truck factor is 1.', evidence: ['F4'] },
    { claim: 'Activity: 1234 commits.', evidence: ['F2'] },
  ],
  hypothesis: { statement: 'With a truck factor of 1, one departure would stall 80 files.', evidence: ['F4'], confidence: 0.6 },
  confidence: 0.6,
  caveats: [],
  ...over,
});

describe('extractNumbers', () => {
  it('finds plain, comma-grouped, decimal and percent numbers but not ids', () => {
    expect(extractNumbers('F12 cites 1,234 commits, 41.2% and p90 of 3.5h').map((n) => n.value)).toEqual([1234, 41.2, 3.5]);
  });
});

describe('guardDraft', () => {
  it('accepts a draft whose numbers are all backed by the facts it cites (with rounding)', () => {
    const r = guardDraft(draft(), FACTS);
    expect(r.ok).toBe(true);
  });

  it('rejects a number the cited facts do not contain', () => {
    const r = guardDraft(draft({ findings: [{ claim: 'Ann wrote 52% of all churn.', evidence: ['F3'] }] }), FACTS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.violations[0]).toMatch(/52%/);
  });

  it('rejects a true number cited against the wrong fact', () => {
    // 1234 is a real fact (F2) but this finding only cites F3.
    const r = guardDraft(draft({ findings: [{ claim: 'Ann landed 1234 commits.', evidence: ['F3'] }] }), FACTS);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown fact ids', () => {
    const r = guardDraft(draft({ findings: [{ claim: 'Something happened.', evidence: ['F999'] }] }), FACTS);
    expect(!r.ok && r.violations.join()).toMatch(/unknown fact F999/);
  });

  it('rejects a hallucinated number in the summary', () => {
    const r = guardDraft(draft({ summary: 'Over 90 days, 7 people did most of the work, writing 41.2% of churn.' }), FACTS);
    expect(!r.ok && r.violations.join()).toMatch(/summary states 7/);
  });

  it('allows dates from the period fact in prose', () => {
    expect(guardDraft(draft({ summary: 'Between 2026-03-01 and 2026-05-30 Ann wrote 41.2% of churn.' }), FACTS).ok).toBe(true);
  });

  it('rejects schema violations and uncited findings', () => {
    expect(guardDraft({ headline: 'x' }, FACTS).ok).toBe(false);
    expect(guardDraft(draft({ findings: [{ claim: 'No evidence here.', evidence: [] }] }), FACTS).ok).toBe(false);
    expect(guardDraft(draft({ confidence: 1.4 }), FACTS).ok).toBe(false);
  });
});
