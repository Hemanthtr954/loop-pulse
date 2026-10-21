import { z } from 'zod';
import { parseRepoRef, type RepoRef } from './domain/repo-ref.js';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const repoList = (fallback = '') =>
  z
  .string()
  .default(fallback)
  .transform((value, ctx): RepoRef[] => {
    const refs: RepoRef[] = [];
    for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const ref = parseRepoRef(raw);
      if (!ref) {
        ctx.addIssue({ code: 'custom', message: `"${raw}" is not a valid owner/name` });
        return z.NEVER;
      }
      refs.push(ref);
    }
    return refs;
  });

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().default('./data'),
  WEB_DIST_DIR: z.string().default('./web/dist'),

  TRACKED_REPOS: repoList('fastify/fastify'),
  ALLOWED_REPOS: repoList(),
  ALLOW_ANY_PUBLIC_REPO: bool,
  MAX_REPOS: z.coerce.number().int().min(1).max(500).default(20),

  SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(30).max(1825).default(365),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(30),
  GIT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),

  GITHUB_TOKEN: optionalSecret,
  GITHUB_API_URL: z.url().default('https://api.github.com'),
  GITHUB_MAX_PRS_PER_SYNC: z.coerce.number().int().min(1).max(10_000).default(500),

  LLM_PROVIDER: z.enum(['auto', 'anthropic', 'openai', 'rules']).default('auto'),
  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  LLM_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(25),

  API_KEY: optionalSecret,
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly dataDir: string;
  readonly webDistDir: string;
  readonly repos: {
    readonly tracked: readonly RepoRef[];
    readonly allowed: readonly RepoRef[];
    readonly allowAnyPublic: boolean;
    readonly max: number;
  };
  readonly sync: {
    readonly lookbackDays: number;
    readonly intervalMinutes: number;
    readonly gitTimeoutMs: number;
  };
  readonly github: {
    readonly token: string | undefined;
    readonly apiUrl: string;
    readonly maxPrsPerSync: number;
  };
  readonly llm: {
    readonly provider: 'anthropic' | 'openai' | 'rules';
    readonly anthropic: { readonly apiKey: string | undefined; readonly model: string };
    readonly openai: { readonly apiKey: string | undefined; readonly baseUrl: string; readonly model: string };
    readonly timeoutMs: number;
  };
  readonly apiKey: string | undefined;
  readonly corsOrigins: readonly string[];
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  let provider: Config['llm']['provider'];
  if (e.LLM_PROVIDER === 'auto') {
    provider = e.ANTHROPIC_API_KEY ? 'anthropic' : e.OPENAI_API_KEY ? 'openai' : 'rules';
  } else {
    provider = e.LLM_PROVIDER;
  }
  if (provider === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    throw new ConfigError('Invalid configuration:\n  LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  // OpenAI-compatible local servers (e.g. Ollama) do not need a key, so none is required here.

  return Object.freeze({
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    dataDir: e.DATA_DIR,
    webDistDir: e.WEB_DIST_DIR,
    repos: { tracked: e.TRACKED_REPOS, allowed: e.ALLOWED_REPOS, allowAnyPublic: e.ALLOW_ANY_PUBLIC_REPO, max: e.MAX_REPOS },
    sync: {
      lookbackDays: e.SYNC_LOOKBACK_DAYS,
      intervalMinutes: e.SYNC_INTERVAL_MINUTES,
      gitTimeoutMs: e.GIT_TIMEOUT_SECONDS * 1000,
    },
    github: { token: e.GITHUB_TOKEN, apiUrl: e.GITHUB_API_URL.replace(/\/+$/, ''), maxPrsPerSync: e.GITHUB_MAX_PRS_PER_SYNC },
    llm: {
      provider,
      anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
      openai: { apiKey: e.OPENAI_API_KEY, baseUrl: e.OPENAI_BASE_URL.replace(/\/+$/, ''), model: e.OPENAI_MODEL },
      timeoutMs: e.LLM_TIMEOUT_SECONDS * 1000,
    },
    apiKey: e.API_KEY,
    corsOrigins: e.CORS_ORIGINS,
  });
}
