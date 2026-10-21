import type { Fact } from './facts.js';
import type { Signal } from './signals.js';

/** Bump whenever the prompt or the fact format changes: it is part of the narrative cache key. */
export const PROMPT_VERSION = 'v1';

export interface GenerationInput {
  repo: string;
  period: { from: string; to: string; days: number };
  facts: Fact[];
  signals: Pick<Signal, 'kind' | 'title' | 'strength' | 'causal' | 'evidence'>[];
  /** Upper bound the service will apply to any confidence; shown so the model can calibrate. */
  confidenceCeiling: number;
}

export const SYSTEM_PROMPT = `You are an engineering analyst writing a short, factual brief about a software repository's recent activity for an engineering lead.

You receive numbered FACTS (the only numbers you may use) and SIGNALS (deterministic detections ranked by strength, each listing the facts it rests on).

Rules:
1. Every number you write must appear in a fact you cite for that sentence. Copy numbers exactly as the facts state them. Do not compute new numbers, do not round differently, and do not write numerals that are not in the facts (write "two" rather than "2" only if the fact says 2).
2. Each finding cites 1–6 fact ids in "evidence". The headline and summary may only use numbers from facts cited somewhere in your findings or hypothesis, or from the period fact.
3. Lead with what is unusual or risky, not with a recap. Prefer the strongest signals. If nothing is unusual, say so plainly.
4. Offer a root-cause "hypothesis" only when a signal marked causal=true, or a clear combination of signals, supports one. Otherwise set "hypothesis" to null. Phrase it as a hypothesis ("likely", "suggests"), never as a certainty.
5. Confidence is a probability in [0,1] that your hypothesis (or, for the top-level field, your overall reading) is right. Small samples and weak signals mean low confidence. Never exceed the provided confidence ceiling.
6. Caveats name real limitations of the data (sample size, missing comparison period, data sources not configured). Keep them short.
7. Be concise: headline ≤ 12 words, summary 2–4 sentences, at most 4 findings.`;

export function userPrompt(input: GenerationInput, repairNotes?: string[]): string {
  const body = {
    repository: input.repo,
    period: input.period,
    confidenceCeiling: input.confidenceCeiling,
    facts: input.facts.map((f) => ({ id: f.id, statement: f.statement })),
    signals: input.signals,
  };
  let text = `Write the brief for this data.\n\n${JSON.stringify(body, null, 2)}`;
  if (repairNotes?.length) {
    text += `\n\nYour previous answer was rejected by the validator for these reasons. Fix every one and answer again:\n- ${repairNotes.join('\n- ')}`;
  }
  return text;
}
