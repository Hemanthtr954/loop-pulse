import { SYSTEM_PROMPT, userPrompt, type GenerationInput } from '../prompt.js';
import { NARRATIVE_JSON_SCHEMA } from '../schema.js';
import { ProviderError, type NarrativeProvider } from './types.js';

/**
 * Any OpenAI-compatible Chat Completions endpoint (OpenAI, Azure-compatible gateways, Ollama,
 * vLLM). Uses JSON mode, which is the most widely supported structured-output option; the
 * schema is included in the prompt and enforced by the shared guard.
 */
export class OpenAiProvider implements NarrativeProvider {
  readonly name = 'openai';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: GenerationInput, repairNotes?: string[]): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\nReply with one JSON object matching this JSON Schema:\n${JSON.stringify(NARRATIVE_JSON_SCHEMA)}` },
          { role: 'user', content: userPrompt(input, repairNotes) },
        ],
      }),
    });
    if (!res.ok) throw new ProviderError(`OpenAI-compatible API responded ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('OpenAI-compatible response had no content');
    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderError('OpenAI-compatible response was not valid JSON');
    }
  }
}
