# CREATE.md — how Loop Pulse was built

This file is the build playbook: the plan the project was built from, in the order it was
built. Each task has its own spec in [`docs/specs/`](docs/specs). The outcome, including what
was verified and what wasn't, is in [`docs/FINAL_REPORT.md`](docs/FINAL_REPORT.md).

## 1. The brief, restated

Build a small service that integrates with an external collaboration API and exposes:

1. an HTTP endpoint returning a meaningful insight over a period;
2. an HTTP endpoint where an LLM writes a short narrative over those numbers, with a
   root-cause hypothesis, a confidence score and an evidence chain back to the numbers;
3. production-grade web-service behaviour, local runnability, and short docs.

## 2. The approach, and why it is different

Most submissions of this kind call the GitHub REST API on every request and ask an LLM to
"summarise these numbers". Loop Pulse makes three different bets:

| Bet | What it means | Why |
|---|---|---|
| **Git is the primary integration** | The service keeps a bounded, shallow, bare clone of each repo's default branch and mines `git log` directly (commits, lines, files, trailers, PR numbers from squash subjects). | Commit history costs zero REST rate limit, needs no token for public repos, and yields file-level signals the REST API only gives at one call per commit. GitHub REST is a second, optional source for what git cannot see (reviews, time-to-merge). |
| **Insight = knowledge risk, not a leaderboard** | Besides top contributors, the headline metric is the *truck factor* of the period — how many people would have to leave before most of the actively changed code has nobody who recently worked on it — plus ownership concentration and single-author hotspots. | "Who committed most" is trivia; "how fragile is our knowledge of the code we are changing right now" is the question an engineering lead actually acts on. |
| **The LLM is not trusted** | Numbers are turned into a numbered *fact sheet* (F1, F2, …) and deterministic *signals*. The model must cite fact IDs; a guard rejects any output that cites unknown facts or states a number that is not in the facts it cites. Confidence is capped by how much data supports it. If the model fails twice, a deterministic narrator answers and the response says so. | The assignment asks for an evidence chain. Making it machine-checkable turns "please don't hallucinate" into a property that is enforced and evaluated. |

## 3. Constraints discovered at build time

- The build sandbox can clone public GitHub repos over git but **cannot reach
  `api.github.com`** or any LLM provider, and no LLM key was supplied. Consequences:
  the git source is verified end-to-end against real repositories; the GitHub REST source
  and the Anthropic/OpenAI providers are verified against recorded-shape fixtures only. The
  narrative endpoint works out of the box with the deterministic `rules` provider and
  switches to a real model when a key is set.
- No GitHub account was linked to the session, so the deliverable is a tarball with `.git`
  included (an accepted submission format) rather than a pushed repo.
- `better-sqlite3` downloads prebuilt binaries from GitHub releases, which is blocked here;
  Node 22's built-in `node:sqlite` is used instead (no native build, no extra dependency).

## 4. Stack

TypeScript on Node 22, Fastify 5, Zod (validation + OpenAPI generation), `node:sqlite`
(WAL mode) for storage, Vitest for tests, React + Vite for the dashboard, Docker for
one-command startup.

## 5. Task plan

| # | Task | Spec |
|---|---|---|
| T01 | Scaffold, configuration, security baseline | [T01](docs/specs/T01-scaffold-and-config.md) |
| T02 | Storage schema and migrations | [T02](docs/specs/T02-storage.md) |
| T03 | Git ingestion (clone, fetch, streaming log parser) | [T03](docs/specs/T03-git-ingestion.md) |
| T04 | GitHub REST ingestion (PRs and reviews) | [T04](docs/specs/T04-github-ingestion.md) |
| T05 | Sync orchestration and background worker | [T05](docs/specs/T05-sync-worker.md) |
| T06 | Insight engine (contributors, knowledge risk, activity, reviews, flow) | [T06](docs/specs/T06-insights.md) |
| T07 | HTTP API (REST, errors, caching, auth, rate limits, OpenAPI) | [T07](docs/specs/T07-http-api.md) |
| T08 | Grounded narrative (facts, signals, providers, guard, confidence) | [T08](docs/specs/T08-narrative.md) |
| T09 | Evaluation harness | [T09](docs/specs/T09-evals.md) |
| T10 | Dashboard | [T10](docs/specs/T10-dashboard.md) |
| T11 | Tests and verification against source data | [T11](docs/specs/T11-testing.md) |
| T12 | Containerisation, deployment, docs | [T12](docs/specs/T12-deploy-and-docs.md) |

## 6. Build order and definition of done

1. Specs written first (this file and `docs/specs/*`).
2. Storage → git ingestion → sync, verified by ingesting a real repository and comparing
   counts with raw `git log` output.
3. Insights → API, verified with `fastify.inject` tests and curl against real data.
4. Narrative → evals, verified by the eval suite, including adversarial fake models that
   hallucinate numbers or cite missing facts (the guard must reject both).
5. Dashboard, served by the API from the same container.
6. Docker image built and run; smoke tests against the container; a static snapshot of the
   dashboard published as a hosted demo.
7. Docs: README (60-second quickstart), NOTES.md (submission notes), final report.

Done means: `npm test` green, `npm run typecheck` clean, `npm run eval` passing,
`docker compose up` serving the API and UI, and the numbers cross-checked against git.

## 7. Reproducing the build

```bash
npm ci && npm --prefix web ci
npm run typecheck && npm test && npm run eval
npm run build            # server (tsc) + web (vite)
docker compose up --build
```
