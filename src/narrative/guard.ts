import type { Fact } from './facts.js';
import { NarrativeDraftSchema, type NarrativeDraft } from './schema.js';

/**
 * The guard is what makes the evidence chain trustworthy. A draft passes only if:
 *  - it matches the schema;
 *  - every cited fact id exists;
 *  - every number in a finding or the hypothesis appears in a fact *that it cites*;
 *  - every number in the headline/summary appears in some fact cited anywhere in the draft
 *    (or in the period fact, so dates can be mentioned);
 *  - every number in a caveat appears in some fact.
 */
export type GuardResult = { ok: true; draft: NarrativeDraft } | { ok: false; violations: string[] };

// A number not glued to a word character (so "F12", "v2", "p90" are not numbers here).
const NUMBER_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?%?/g;

export function extractNumbers(text: string): { raw: string; value: number; percent: boolean }[] {
  const out: { raw: string; value: number; percent: boolean }[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const percent = raw.endsWith('%');
    const value = Number(raw.replace(/[,%]/g, ''));
    if (Number.isFinite(value)) out.push({ raw, value, percent });
  }
  return out;
}

/** All numbers a fact legitimately "contains": those in its statement plus its value's renderings. */
function allowedNumbers(fact: Fact): number[] {
  const values = extractNumbers(fact.statement).map((n) => n.value);
  const v = Math.abs(fact.value);
  values.push(v, round(v, 0), round(v, 1), round(v, 2));
  if (fact.unit === 'ratio') values.push(round(v * 100, 0), round(v * 100, 1));
  return values;
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function backedBy(n: number, facts: Fact[]): boolean {
  return facts.some((f) => allowedNumbers(f).some((a) => Math.abs(a - n) < 1e-9));
}

export function guardDraft(raw: unknown, facts: readonly Fact[]): GuardResult {
  const parsed = NarrativeDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: parsed.error.issues.slice(0, 6).map((i) => `schema: ${i.path.join('.') || '(root)'} ${i.message}`) };
  }
  const draft = parsed.data;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const violations: string[] = [];

  const resolve = (ids: string[], where: string): Fact[] => {
    const found: Fact[] = [];
    for (const id of ids) {
      const f = byId.get(id);
      if (f) found.push(f);
      else violations.push(`${where} cites unknown fact ${id}`);
    }
    return found;
  };
  const checkText = (text: string, allowed: Fact[], where: string) => {
    for (const n of extractNumbers(text)) {
      if (!backedBy(n.value, allowed)) violations.push(`${where} states ${n.raw}, which is not in the facts it cites`);
    }
  };

  const cited: Fact[] = [];
  draft.findings.forEach((f, i) => {
    const facts = resolve(f.evidence, `findings[${i}]`);
    cited.push(...facts);
    checkText(f.claim, facts, `findings[${i}]`);
  });
  if (draft.hypothesis) {
    const facts = resolve(draft.hypothesis.evidence, 'hypothesis');
    cited.push(...facts);
    checkText(draft.hypothesis.statement, facts, 'hypothesis');
  }
  // The period fact is always in scope for prose, so dates and the period length can be mentioned.
  const prose = [...cited, ...facts.filter((f) => f.key === 'period.days')];
  checkText(draft.headline, prose, 'headline');
  checkText(draft.summary, prose, 'summary');
  draft.caveats.forEach((c, i) => checkText(c, [...facts], `caveats[${i}]`));

  return violations.length ? { ok: false, violations: [...new Set(violations)].slice(0, 10) } : { ok: true, draft };
}
