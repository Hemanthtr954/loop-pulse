import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/database.js';
import type { RepoRow } from '../db/repo-store.js';
import { periodToJson, type Period } from '../domain/period.js';
import type { InsightService } from '../insights/insight-service.js';
import { buildFacts, type Fact, type InsightBundle } from './facts.js';
import { guardDraft } from './guard.js';
import { PROMPT_VERSION, type GenerationInput } from './prompt.js';
import { RulesProvider } from './providers/rules.js';
import type { NarrativeProvider } from './providers/types.js';
import type { NarrativeDraft } from './schema.js';
import { dataSufficiency, detectSignals, type Signal } from './signals.js';

export interface NarrativeResponse {
  narrative: Omit<NarrativeDraft, 'confidence' | 'hypothesis'> & {
    hypothesis: (Omit<NonNullable<NarrativeDraft['hypothesis']>, 'confidence'> & { confidence: number; modelConfidence: number }) | null;
  };
  confidence: { value: number; model: number; ceiling: number; rationale: string };
  evidence: Record<string, Omit<Fact, 'id'>>;
  signals: Signal[];
  generation: {
    provider: string;
    model: string;
    promptVersion: string;
    attempts: number;
    degraded: boolean;
    degradedReason: string | null;
    cached: boolean;
  };
}

export interface BuiltInput {
  bundle: InsightBundle;
  facts: Fact[];
  signals: Signal[];
  input: GenerationInput;
  sufficiency: number;
}

/** Above this the model's hypothesis needs a causal signal behind it, or it is capped. */
const UNSUPPORTED_HYPOTHESIS_CAP = 0.5;

export class NarrativeService {
  private readonly rules = new RulesProvider();

  constructor(
    private readonly db: Db,
    private readonly insights: InsightService,
    private readonly provider: NarrativeProvider,
    private readonly log: FastifyBaseLogger,
    private readonly githubEnabled: boolean,
  ) {}

  /** Gathers insights, builds facts and signals. Exposed for the eval harness. */
  buildInput(repo: RepoRow, period: Period, basePath: string, query: string): BuiltInput {
    const bundle: InsightBundle = {
      repo: `${repo.owner}/${repo.name}`,
      period: periodToJson(period),
      contributors: this.insights.contributors(repo, period, false),
      knowledgeRisk: this.insights.knowledgeRisk(repo, period, false),
      activity: this.insights.activity(repo, period, false),
      reviewers: this.githubEnabled ? this.insights.reviewers(repo, period, false, 10) : null,
      flow: this.githubEnabled ? this.insights.flow(repo, period, false) : null,
    };
    return assembleInput(bundle, basePath, query);
  }

  async narrate(repo: RepoRow, period: Period, basePath: string, query: string): Promise<NarrativeResponse> {
    const built = this.buildInput(repo, period, basePath, query);
    const key = createHash('sha256')
      .update(JSON.stringify([repo.id, period.from, period.to, repo.data_version, this.provider.name, this.provider.model, PROMPT_VERSION]))
      .digest('hex');
    const cached = this.db.prepare('SELECT body_json FROM narratives WHERE cache_key = ?').get(key) as { body_json: string } | undefined;
    if (cached) {
      const body = JSON.parse(cached.body_json) as NarrativeResponse;
      return { ...body, generation: { ...body.generation, cached: true } };
    }

    const result = await generateGuarded(this.provider, this.rules, built, this.log);
    this.db
      .prepare('INSERT OR REPLACE INTO narratives (cache_key, repo_id, created_at, body_json) VALUES (?, ?, ?, ?)')
      .run(key, repo.id, Date.now(), JSON.stringify(result));
    return result;
  }
}

export function assembleInput(bundle: InsightBundle, basePath: string, query: string): BuiltInput {
  const sheet = buildFacts(bundle, basePath, query);
  const signals = detectSignals(bundle, sheet);
  const sufficiency = dataSufficiency(bundle);
  const input: GenerationInput = {
    repo: bundle.repo,
    period: bundle.period,
    facts: sheet.facts,
    signals: signals.map(({ kind, title, strength, causal, evidence }) => ({ kind, title, strength, causal, evidence })),
    confidenceCeiling: confidenceCeiling(sufficiency),
  };
  return { bundle, facts: sheet.facts, signals, input, sufficiency };
}

export function confidenceCeiling(sufficiency: number): number {
  return Math.round((0.3 + 0.6 * sufficiency) * 100) / 100;
}

/**
 * Provider → guard → (one repair) → guard → fallback to the deterministic narrator.
 * Whatever comes back has passed the guard.
 */
export async function generateGuarded(
  provider: NarrativeProvider,
  fallback: NarrativeProvider,
  built: BuiltInput,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<NarrativeResponse> {
  let attempts = 0;
  let notes: string[] | undefined;
  let reason: string | null = null;

  if (provider.name !== fallback.name) {
    for (let i = 0; i < 2; i++) {
      attempts++;
      try {
        const raw = await provider.generate(built.input, notes);
        const verdict = guardDraft(raw, built.facts);
        if (verdict.ok) return finalise(verdict.draft, built, provider, attempts, null);
        notes = verdict.violations;
        reason = `validation failed: ${verdict.violations.slice(0, 3).join('; ')}`;
      } catch (err) {
        reason = `provider error: ${err instanceof Error ? err.message : String(err)}`;
        break; // transport/API errors are not fixed by a repair prompt
      }
    }
    log.warn({ provider: provider.name, reason }, 'narrative degraded to rules');
  }

  const raw = await fallback.generate(built.input);
  const verdict = guardDraft(raw, built.facts);
  if (!verdict.ok) throw new Error(`rules narrator failed its own guard: ${verdict.violations.join('; ')}`);
  return finalise(verdict.draft, built, fallback, attempts + 1, reason);
}

function finalise(
  draft: NarrativeDraft,
  built: BuiltInput,
  provider: NarrativeProvider,
  attempts: number,
  degradedReason: string | null,
): NarrativeResponse {
  const ceiling = built.input.confidenceCeiling;
  const causalFacts = new Set(built.signals.filter((s) => s.causal && s.strength >= 0.5).flatMap((s) => s.evidence));

  let hypothesis: NarrativeResponse['narrative']['hypothesis'] = null;
  let rationale = `Upper bound ${ceiling} from data sufficiency ${built.sufficiency.toFixed(2)} (commits, full weeks and authors in the period).`;
  if (draft.hypothesis) {
    const supported = draft.hypothesis.evidence.some((id) => causalFacts.has(id));
    const cap = supported ? ceiling : Math.min(ceiling, UNSUPPORTED_HYPOTHESIS_CAP);
    if (!supported) rationale += ` The hypothesis cites no fact behind a strong causal signal, so it is capped at ${UNSUPPORTED_HYPOTHESIS_CAP}.`;
    hypothesis = {
      statement: draft.hypothesis.statement,
      evidence: draft.hypothesis.evidence,
      modelConfidence: draft.hypothesis.confidence,
      confidence: round2(Math.min(draft.hypothesis.confidence, cap)),
    };
  }

  const cited = new Set([...draft.findings.flatMap((f) => f.evidence), ...(draft.hypothesis?.evidence ?? [])]);
  const evidence: NarrativeResponse['evidence'] = {};
  for (const f of built.facts) {
    if (cited.has(f.id)) {
      const { id: _id, ...rest } = f;
      evidence[f.id] = rest;
    }
  }

  return {
    narrative: {
      headline: draft.headline,
      summary: draft.summary,
      findings: draft.findings,
      hypothesis,
      caveats: draft.caveats,
    },
    confidence: { value: round2(Math.min(draft.confidence, ceiling)), model: draft.confidence, ceiling, rationale },
    evidence,
    signals: built.signals,
    generation: {
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      attempts,
      degraded: degradedReason !== null,
      degradedReason,
      cached: false,
    },
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
