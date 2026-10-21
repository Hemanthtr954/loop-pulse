import { SYSTEM_PROMPT, userPrompt, type GenerationInput } from '../prompt.js';
import { NARRATIVE_JSON_SCHEMA } from '../schema.js';
import { ProviderError, type NarrativeProvider } from './types.js';

const TOOL_NAME = 'submit_brief';

/** Anthropic Messages API with forced tool use, so the reply is always a JSON object. */
export class AnthropicProvider implements NarrativeProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: GenerationInput, repairNotes?: string[]): Promise<unknown> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        tools: [{ name: TOOL_NAME, description: 'Submit the repository brief.', input_schema: NARRATIVE_JSON_SCHEMA }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: userPrompt(input, repairNotes) }],
      }),
    });
    if (!res.ok) throw new ProviderError(`Anthropic API responded ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
    const call = body.content?.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME);
    if (!call) throw new ProviderError('Anthropic response contained no tool call');
    return call.input;
  }
}
