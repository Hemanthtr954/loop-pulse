# T01 — Scaffold, configuration, security baseline

## Goal
A TypeScript service skeleton that starts, validates its configuration up front and fails
fast with a readable error, and has its security defaults switched on from the first commit.

## Scope
- `package.json` scripts: `dev`, `build`, `start`, `typecheck`, `test`, `eval`, `lint:secrets`.
- `src/config.ts`: every environment variable parsed once with Zod into a typed, frozen
  `Config`. Nothing else reads `process.env`.
- Logging with pino; `redact` covers `authorization`, `x-api-key`, cookies and any
  config key containing `TOKEN`/`KEY`.
- `.env.example` documents every variable; `.env` is git-ignored.

## Configuration contract

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | SQLite file and git mirrors |
| `TRACKED_REPOS` | `fastify/fastify` | Comma-separated `owner/name` list synced on boot |
| `ALLOW_ANY_PUBLIC_REPO` | `false` | If false, `POST /v1/repos` only accepts repos in `TRACKED_REPOS` / `ALLOWED_REPOS` |
| `ALLOWED_REPOS` | empty | Extra repos that may be registered at runtime |
| `MAX_REPOS` | `20` | Upper bound on registered repos (disk/CPU guard) |
| `SYNC_LOOKBACK_DAYS` | `365` | History horizon kept locally |
| `SYNC_INTERVAL_MINUTES` | `30` | Background refresh cadence; `0` disables |
| `GITHUB_TOKEN` | empty | Enables the PR/review source (read-only, public data) |
| `GITHUB_MAX_PRS_PER_SYNC` | `500` | Bounds REST calls per sync |
| `LLM_PROVIDER` | auto | `anthropic`, `openai`, `rules`; auto picks by available key |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | — | Anthropic provider |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | — | Any OpenAI-compatible endpoint (incl. Ollama) |
| `API_KEY` | empty | If set, required as `x-api-key` on mutating endpoints |
| `CORS_ORIGINS` | empty | Allowed browser origins (same-origin UI needs none) |
| `LOG_LEVEL` | `info` | pino level |

## Acceptance criteria
- Invalid config (e.g. `PORT=abc`, malformed repo in `TRACKED_REPOS`) exits with code 1 and
  a message naming the variable; no stack trace dump.
- A grep of the repo for token-shaped strings finds nothing; logs never contain the value
  of `GITHUB_TOKEN`, `API_KEY` or LLM keys (covered by a test that logs a request carrying
  an `x-api-key` header and asserts the value is absent).

## Out of scope
Secret managers, multi-tenant auth. A single shared API key protects writes; reads are
public, because the underlying data is public.
