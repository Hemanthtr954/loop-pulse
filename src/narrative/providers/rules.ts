import type { Fact } from '../facts.js';
import type { GenerationInput } from '../prompt.js';
import type { NarrativeDraft } from '../schema.js';
import type { NarrativeProvider } from './types.js';

/**
 * Deterministic narrator. It is the default when no LLM is configured, the fallback when a
 * model fails validation twice, and the baseline in the eval suite. It only ever writes
 * fact statements verbatim, so it passes the guard by construction.
 */
export class RulesProvider implements NarrativeProvider {
  readonly name = 'rules';
  readonly model = 'rules-v1';

  async generate(input: GenerationInput): Promise<NarrativeDraft> {
    return narrate(input);
  }
}

export function narrate(input: GenerationInput): NarrativeDraft {
  const byId = new Map(input.facts.map((f) => [f.id, f]));
  const byKey = new Map(input.facts.map((f) => [f.key, f]));
  const statement = (id: string) => byId.get(id)?.statement ?? '';
  const pick = (...keys: string[]) => keys.map((k) => byKey.get(k)).filter((f): f is Fact => !!f);

  const findings: NarrativeDraft['findings'] = input.signals.slice(0, 4).map((s) => ({
    claim: `${s.title}: ${s.evidence.slice(0, 2).map(statement).join(' ')}`,
    evidence: s.evidence.slice(0, 6),
  }));

  // The overview is always a cited finding, so the summary's numbers are covered by evidence.
  const overview = pick('totals.commits', 'totals.authors', ...(findings.length ? [] : ['risk.effective']));
  findings.push({
    claim: `${findings.length ? 'Overall' : 'No unusual pattern stands out'}: ${overview.map((f) => f.statement).join(' ')}`,
    evidence: overview.map((f) => f.id),
  });

  const top = input.signals[0];
  const headline = top ? top.title : 'Steady activity with no unusual patterns';
  const summary = [
    overview.slice(0, 2).map((f) => f.statement).join(' '),
    ...input.signals.slice(0, 2).map((s) => statement(s.evidence[0]!)),
  ]
    .filter(Boolean)
    .join(' ');

  const causal = input.signals.find((s) => s.causal);
  let hypothesis: NarrativeDraft['hypothesis'] = null;
  if (causal?.kind === 'contributor-departure') {
    const ev = causal.evidence;
    hypothesis = {
      statement: `The drop in activity is likely driven by previously central contributors going quiet. ${statement(ev[0]!)}`,
      evidence: ev.slice(0, 6),
      confidence: Math.min(causal.strength, input.confidenceCeiling),
    };
  } else if (causal?.kind === 'newcomer-surge') {
    hypothesis = {
      statement: `The increase in activity is likely driven by new contributors. ${statement(causal.evidence[0]!)}`,
      evidence: causal.evidence.slice(0, 6),
      confidence: Math.min(causal.strength, input.confidenceCeiling),
    };
  }

  const caveats: string[] = [];
  if (!byKey.has('previous.commits')) caveats.push('No comparison with the previous period: it lies outside the synced history.');
  const commits = byKey.get('totals.commits')?.value ?? 0;
  if (commits < 30) caveats.push('Small sample: conclusions drawn from this period are tentative.');
  if (!byKey.has('reviews.total') && !byKey.has('flow.merged')) caveats.push('Review and time-to-merge data are not included (GitHub token not configured or no data).');
  const incomplete = byKey.get('totals.incomplete');
  if (incomplete) caveats.push(incomplete.statement);

  const strongest = input.signals[0]?.strength ?? 0.3;
  return {
    headline: headline.slice(0, 140),
    summary: (summary || 'There was no activity in this period.').slice(0, 900),
    findings,
    hypothesis,
    confidence: Math.min(input.confidenceCeiling, Math.max(0.2, strongest)),
    caveats: caveats.slice(0, 4),
  };
}
