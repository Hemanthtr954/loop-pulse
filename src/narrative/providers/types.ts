import type { GenerationInput } from '../prompt.js';

/**
 * A provider turns facts + signals into an *unvalidated* draft. Parsing, guarding and
 * calibration are shared by the service, so no provider can bypass them.
 */
export interface NarrativeProvider {
  readonly name: 'anthropic' | 'openai' | 'rules' | string;
  readonly model: string;
  generate(input: GenerationInput, repairNotes?: string[]): Promise<unknown>;
}

export class ProviderError extends Error {}
