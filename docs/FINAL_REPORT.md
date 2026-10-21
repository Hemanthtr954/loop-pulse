# Final report — Loop Pulse

**Built:** 2026-10-21 · **Stack:** TypeScript, Node 22, Fastify 5, Zod 4, `node:sqlite`, React 19 + Vite, Docker

## Outcome

Every hard requirement of the assignment is met, plus most of the optional list.

| Requirement | Status | Where |
|---|---|---|
| Integrate an external API with enough data for something meaningful | ✅ GitHub via git (primary, verified live on 3 repos) + GitHub REST for PRs/reviews (fixture-verified) | `src/ingest` |
| HTTP endpoint with an insight over a period | ✅ 5 insight endpoints; headline = knowledge risk | `src/insights`, `src/http/routes/insights.ts` |
| LLM narrative with root-cause hypothesis, confidence, evidence chain | ✅ guarded, calibrated, every claim cites fact ids resolvable to endpoint + JSON pointer | `src/narrative` |
| Metric documented | ✅ README "The metric, and why" + `meta.definitions` in every response | |
| Queryable over HTTP | ✅ REST, OpenAPI 3.1, Swagger UI at `/docs` | `src/http/openapi.ts` |
| Runnable locally with clear setup | ✅ `docker compose up --build`, or `npm ci && npm run build && npm start` | README, NOTES |
| Production-grade practices | ✅ problem+json, ETag/304, rate limits, CSP, API key on writes, allowlist, input validation, redacted logs, non-root read-only container | |
| *Optional:* frontend | ✅ React dashboard served by the API; hosted snapshot | `web/` |
| *Optional:* more signals | ✅ trends, previous-period deltas, departures/newcomers, weekend share, time-to-merge, review load, stale PRs | |
| *Optional:* caching / persistence | ✅ SQLite store, data-versioned memo cache, narrative cache, ETags | |
| *Optional:* more than one integration / easy to extend | ✅ git + GitHub REST; LLM providers: Anthropic, OpenAI-compatible, deterministic | |
| *Optional:* background sync | ✅ scheduler with jitter, single flight, bounded concurrency | `src/ingest/sync-service.ts` |
| *Optional:* tests | ✅ 91 tests | `test/` |
| *Optional:* eval harness | ✅ 6 planted-story cases × 3 providers (incl. 2 adversaries), 8 graders | `evals/` |
| *Optional:* containerisation | ✅ multi-stage Dockerfile + compose | |

## What makes this submission different

1. **Git-native ingestion.** Commits, lines, files, co-authors and PR numbers come from a
   bounded shallow mirror, so the core service needs no token and spends no API quota.
2. **Knowledge risk as the insight**: truck factor, concentration, silos, area ownership.
3. **A machine-checked evidence chain.** The LLM can only use numbered facts; a guard rejects
   unknown citations and any number not in the cited facts; confidence is capped by data
   sufficiency; failures degrade to a deterministic narrator and say so in the response.

## Verification evidence

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | clean |
| `npm test` (Vitest) | **91 / 91 passed** in 9 files |
| `npm run eval` | **18 / 18 case runs passed**; both adversaries (number hallucination, fabricated citation) rejected at first pass and degraded every time |
| `npm audit` (server and web) | 0 vulnerabilities |
| Docker image build | built (122 MB content); container healthy under compose with read-only root FS, non-root user |
| `scripts/smoke.sh` against the container | **17 / 17 passed** (health, UI, OpenAPI, Swagger, all insights, narrative, 304, 400, 404, 422, 409, problem+json, CSP) |
| API vs raw git (`npm run verify:git`) | **36 / 36 exact matches**: commits, distinct authors, lines added, lines deleted × 3 repos × 3 windows |
| Dashboard render | desktop light, desktop dark, 375 px dark: no console errors, no horizontal overflow |

API vs git cross-check (independent git invocations and parsing):

| Repo | Window | Commits | Authors | Added | Deleted |
|---|---|---|---|---|---|
| fastify/fastify | 2026-07-23 → 10-21 | 117 = 117 | 47 = 47 | 5852 = 5852 | 3104 = 3104 |
| fastify/fastify | 2026-01-01 → 07-01 | 173 = 173 | 62 = 62 | 8298 = 8298 | 4038 = 4038 |
| fastify/fastify | 2025-11-01 → 10-22 | 344 = 344 | 112 = 112 | 16181 = 16181 | 7612 = 7612 |
| expressjs/express | 2026-07-23 → 10-21 | 25 = 25 | 15 = 15 | 791 = 791 | 687 = 687 |
| expressjs/express | 2026-01-01 → 07-01 | 48 = 48 | 27 = 27 | 458 = 458 | 330 = 330 |
| expressjs/express | 2025-11-01 → 10-22 | 95 = 95 | 43 = 43 | 1459 = 1459 | 1160 = 1160 |
| pallets/flask | 2026-07-23 → 10-21 | 16 = 16 | 3 = 3 | 369 = 369 | 360 = 360 |
| pallets/flask | 2026-01-01 → 07-01 | 39 = 39 | 4 = 4 | 1103 = 1103 | 894 = 894 |
| pallets/flask | 2025-11-01 → 10-22 | 60 = 60 | 6 = 6 | 1486 = 1486 | 1265 = 1265 |

The scripted fixture repository (`test/helpers/fixture-repo.ts`) additionally pins down, with
exact expected values: the shallow-boundary commit, a merge commit, a rename with an edit, a
binary file, a 1,000-line lockfile, a co-author trailer, a bot commit, and two timezone edge
cases for weekend detection.

## A sample of what it finds (fastify/fastify, last 90 days)

113 human commits by 46 authors (+68.7 % versus the previous 90 days). Truck factor 3; the top
author wrote 26 % of churn; effective contributors 5.4. The narrative's hypothesis: the rise is
likely driven by newcomers, whose commits equal 78.3 % of the 46-commit increase, with
confidence 0.78 (ceiling 0.90 from data sufficiency).

## Deviations from the specs, and why

- **Eval cases live in code** (`evals/cases.ts`) rather than JSON, so they always type-check
  against the real insight types.
- **Data sufficiency is multiplicative** instead of a weighted sum: the additive version let a
  15-commit period reach 65 % confidence because many authors and active weeks compensated for
  few commits.
- **Default tracked repos** are fastify and express (the spec said fastify only), so the
  dashboard has two repos to switch between on first start.

## Limits of what was verified

- **GitHub REST source and LLM providers were not exercised live.** The build sandbox could not
  reach `api.github.com` or any LLM API, and no keys were provided. Both are covered by tests
  against fixtures shaped like the documented responses, and the narrative endpoint works out
  of the box with the deterministic narrator. First thing to do with a key:
  `npm run eval -- --provider anthropic`.
- **The Docker image was built on a stand-in base image.** Docker Hub was unreachable from the
  sandbox, so `node:22-slim` was substituted locally by an image with the same Node 22 and git;
  the Dockerfile itself is unchanged and its `apt-get` step installs git on the real base.
- **Not pushed to GitHub.** No GitHub account was linked to the session; the deliverable is a
  tarball with `.git` included, which the assignment accepts.
- **Identity splitting** without `.mailmap` (one person with two e-mails counts as two) is a
  known limitation; see NOTES "What I'd do next".

## Deliverables

- Source with full git history: `loop-pulse.tar.gz`
- Hosted dashboard snapshot with real data (fastify, flask, express; 30/90/180-day views)
- `README.md`, `NOTES.md`, `CREATE.md`, `docs/specs/T01…T12`, this report
