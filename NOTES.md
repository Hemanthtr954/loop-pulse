# Submission notes

## 1. How to run it locally

**Docker (recommended):**

```bash
cp .env.example .env        # optional; all settings have defaults
docker compose up --build   # http://localhost:8080 (dashboard), /docs (OpenAPI), /v1/... (API)
```

**Node:** Node ≥ 22.13 (uses the built-in `node:sqlite`) and `git` on PATH.

```bash
npm ci && npm --prefix web ci
npm run build && npm start
```

Prerequisites and credentials: none for the core features — the service clones public
repositories over git. Optional: `GITHUB_TOKEN` (fine-grained, public read-only) enables the
reviewers and flow insights; `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`/`OPENAI_BASE_URL` (any
OpenAI-compatible endpoint, including a local Ollama), switches the narrative from the
deterministic narrator to an LLM. `API_KEY` protects the two POST endpoints. Every variable is
listed in `.env.example`.

Checks: `npm test`, `npm run eval`, `npm run typecheck`, `./scripts/smoke.sh`, `npm run verify:git`.

## 2. Architecture tour

Three layers with one-way dependencies. **Ingestion** (`src/ingest`) keeps a shallow, bare,
single-branch mirror of each repo bounded by `SYNC_LOOKBACK_DAYS`, streams `git log --numstat`
through a line parser, and atomically replaces the repo's rows in SQLite. A background
scheduler refreshes every repo (single flight per repo, two clones at a time); unchanged heads
skip re-ingestion. An optional GitHub REST source adds PRs and reviews with a cursor, an ETag on
the first page, and a review backlog drained across runs, so rate limits are never blown by one
sync. **Insights** (`src/insights`) are indexed SQL aggregations plus small in-memory steps (the
greedy truck factor), memoised by `(repo, data_version, query)` so a cache can never outlive the
data. **HTTP** (`src/http`) is Fastify with Zod-validated input, problem+json errors, weak ETags
checked before any computation (a 304 is nearly free), rate limits, helmet/CSP, an API key on
writes, and an OpenAPI document generated from the same Zod schemas the handlers use.

The decisions I'd defend in review:

- **Git, not REST, as the primary source.** One clone gives a year of commits with file-level
  numstat, co-author trailers and squash-merge PR numbers, at zero API quota. Line counts per
  commit would cost one REST call each. REST is used only for what git cannot know.
- **Knowledge risk as the headline insight**, because it is actionable and explainable; the
  definitions travel in every response.
- **An LLM that is checked, not trusted.** The narrative endpoint turns insights into numbered
  facts (each with a pointer back to the endpoint and JSON field it came from), runs
  deterministic signal detectors, and asks the model for a structured brief citing fact ids. A
  guard rejects drafts with unknown ids or with any number not present in the facts that claim
  cites; the model gets one repair round, then the deterministic narrator answers and the
  response says `degraded: true`. Confidence is `min(model, ceiling)`, where the ceiling comes
  from data sufficiency, and hypotheses without a causal signal behind them are capped at 0.5.
- **Correctness traps handled explicitly:** shallow-boundary commits would otherwise "add the
  whole tree" to someone's line count; merge commits, renames, binaries, lockfiles and bots each
  have a rule, and API totals were cross-checked against raw git (see the final report).
- **SQLite via `node:sqlite`:** no native build, WAL, plain SQL that ports to Postgres.

## 3. What I'd do next with another day

1. **Identity resolution.** People with two e-mails appear twice unless the repo has a
   `.mailmap` (fastify's "KaKa" shows up twice). I'd merge identities by GitHub login once the
   REST source is on, and support an operator-supplied mailmap.
2. **Run the evals against real models** and tune the prompt on the failures. The harness is
   ready (`npm run eval -- --provider anthropic`), but no LLM key or GitHub API access was
   available where this was built, so live runs and the REST source are verified only against
   fixtures.
3. **Ingestion without event-loop pauses for huge repos.** The replace-in-one-transaction step
   is synchronous; it is milliseconds for these repos but would pause the loop for a very large
   monorepo. I'd move it to a worker thread with a generation-swap (write new rows under a new
   generation in chunks, flip a pointer, delete the old ones).
4. **Knowledge risk over longer windows** with decay (recent changes weigh more), and trend
   lines of truck factor by month.
5. Postgres adapter and a separate worker process if this were multi-tenant.

## 4. Use of AI

I used Claude Code as an agent for most of the implementation: it worked spec-first from the
assignment brief (one spec per task in `docs/specs`), then wrote the code, tests, evals and
docs, and checked the results against the tests and raw git output. Things that came out of
that loop and are worth calling out:

- The shallow-clone boundary problem (`--shallow-since` makes the oldest commit look like it
  added the whole tree) was caught by reasoning about the clone before any number looked wrong.
- The first confidence ceiling let a 15-commit period reach 65 % confidence. That looked wrong
  in the dashboard and led to the multiplicative data-sufficiency formula.
- A `GITHUB_TOKEN` already present in my environment was picked up by the config on the first
  run, which is why tests build their config from an explicit environment.

Every number in the final report was re-run before submitting.
