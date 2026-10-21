/**
 * Narrative eval suite. Run before changing the prompt, the fact format or the model:
 *
 *   npm run eval                         # deterministic rules narrator + guard adversaries (offline)
 *   npm run eval -- --provider anthropic # the configured live model (needs ANTHROPIC_API_KEY)
 *   npm run eval -- --provider openai    # any OpenAI-compatible endpoint (OPENAI_*)
 *
 * Writes evals/report.json and exits 1 if any grader fails.
 */
import { writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { guardDraft } from '../src/narrative/guard.js';
import { assembleInput, generateGuarded, type BuiltInput, type NarrativeResponse } from '../src/narrative/narrative-service.js';
import { createProvider } from '../src/narrative/providers/index.js';
import { RulesProvider } from '../src/narrative/providers/rules.js';
import type { NarrativeProvider } from '../src/narrative/providers/types.js';
import { CASES, type EvalCase } from './cases.js';

const log = pino({ level: 'silent' });

/** Adversaries wrap the rules narrator and corrupt its output in one specific way. */
class Hallucinator implements NarrativeProvider {
  readonly name = 'adversary:hallucinator';
  readonly model = 'changes-a-number';
  async generate(input: BuiltInput['input']) {
    const d = await new RulesProvider().generate(input);
    return { ...d, findings: d.findings.map((f, i) => (i === 0 ? { ...f, claim: `${f.claim} That is 7777 more than expected.` } : f)) };
  }
}
class Fabricator implements NarrativeProvider {
  readonly name = 'adversary:fabricator';
  readonly model = 'cites-missing-facts';
  async generate(input: BuiltInput['input']) {
    const d = await new RulesProvider().generate(input);
    return { ...d, findings: [...d.findings.slice(0, 4), { claim: 'An important trend.', evidence: ['F999'] }] };
  }
}

interface Grade {
  case: string;
  provider: string;
  checks: Record<string, boolean | null>;
  confidence: number;
  degraded: boolean;
  notes: string[];
}

async function gradeCase(c: EvalCase, provider: NarrativeProvider, adversarial: boolean): Promise<Grade> {
  const built = assembleInput(c.bundle, '/v1/repos/example/service/insights', 'from=x&to=y');
  const notes: string[] = [];

  // First-pass guard result on the provider's raw output (before any repair or fallback).
  let firstPass: boolean;
  try {
    const verdict = guardDraft(await provider.generate(built.input), built.facts);
    firstPass = verdict.ok;
    if (!verdict.ok) notes.push(...verdict.violations.slice(0, 2));
  } catch (err) {
    firstPass = false;
    notes.push(`provider error: ${(err as Error).message}`);
  }

  const result: NarrativeResponse = await generateGuarded(provider, new RulesProvider(), built, log);
  const keyOf = new Map(built.facts.map((f) => [f.id, f.key]));
  const cited = new Set([...result.narrative.findings.flatMap((f) => f.evidence), ...(result.narrative.hypothesis?.evidence ?? [])].map((id) => keyOf.get(id)));
  const hyp = result.narrative.hypothesis;
  const conf = hyp?.confidence ?? result.confidence.value;

  const checks: Grade['checks'] = {
    // The pipeline output always passes the guard (that is the point); adversaries must degrade.
    guardedOutput: guardDraft({ ...result.narrative, hypothesis: hyp && { statement: hyp.statement, evidence: hyp.evidence, confidence: hyp.modelConfidence }, confidence: result.confidence.model }, built.facts).ok,
    firstPassGuard: adversarial ? !firstPass : firstPass,
    adversaryDegraded: adversarial ? result.generation.degraded : null,
    signalRecall: c.expect.mustCite.some((k) => cited.has(k)),
    hypothesis:
      c.expect.hypothesis === 'optional'
        ? true
        : c.expect.hypothesis === 'required'
          ? !!hyp && (!c.expect.hypothesisCites || hyp.evidence.some((id) => c.expect.hypothesisCites!.includes(keyOf.get(id)!)))
          : !hyp,
    calibration: (c.expect.confidence?.min ?? 0) <= conf && conf <= (c.expect.confidence?.max ?? 1),
    restraint: c.name === 'healthy-balanced' ? !hyp || hyp.confidence <= 0.5 : null,
    caveat: c.expect.caveat ? result.narrative.caveats.some((x) => c.expect.caveat!.test(x)) : null,
  };
  return { case: c.name, provider: provider.name, checks, confidence: conf, degraded: result.generation.degraded, notes };
}

async function main() {
  const arg = process.argv.indexOf('--provider');
  const live = arg > 0 ? process.argv[arg + 1] : undefined;
  const providers: { p: NarrativeProvider; adversarial: boolean }[] = [];
  if (live) {
    const config = loadConfig({ ...process.env, LLM_PROVIDER: live });
    providers.push({ p: createProvider(config.llm), adversarial: false });
  } else {
    providers.push({ p: new RulesProvider(), adversarial: false }, { p: new Hallucinator(), adversarial: true }, { p: new Fabricator(), adversarial: true });
  }

  const grades: Grade[] = [];
  for (const { p, adversarial } of providers) for (const c of CASES) grades.push(await gradeCase(c, p, adversarial));

  const columns = ['guardedOutput', 'firstPassGuard', 'adversaryDegraded', 'signalRecall', 'hypothesis', 'calibration', 'restraint', 'caveat'];
  const cell = (v: boolean | null | undefined) => (v === null || v === undefined ? '  ·  ' : v ? ' pass' : ' FAIL');
  console.log(`${'provider'.padEnd(24)}${'case'.padEnd(20)}${columns.map((c) => c.slice(0, 9).padStart(10)).join('')}   conf`);
  for (const g of grades) {
    console.log(`${g.provider.padEnd(24)}${g.case.padEnd(20)}${columns.map((c) => cell(g.checks[c]).padStart(10)).join('')}   ${g.confidence.toFixed(2)}`);
  }
  const failures = grades.flatMap((g) => Object.entries(g.checks).filter(([, v]) => v === false).map(([k]) => `${g.provider}/${g.case}: ${k} ${g.notes.join(' | ')}`));
  writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), grades, failures }, null, 2));
  console.log(failures.length ? `\n${failures.length} failing check(s):\n- ${failures.join('\n- ')}` : `\nAll ${grades.length} case runs passed.`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
