import type { Config } from '../../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import { RulesProvider } from './rules.js';
import type { NarrativeProvider } from './types.js';

export function createProvider(llm: Config['llm']): NarrativeProvider {
  switch (llm.provider) {
    case 'anthropic':
      return new AnthropicProvider(llm.anthropic.apiKey!, llm.anthropic.model, llm.timeoutMs);
    case 'openai':
      return new OpenAiProvider(llm.openai.baseUrl, llm.openai.apiKey, llm.openai.model, llm.timeoutMs);
    case 'rules':
      return new RulesProvider();
  }
}
