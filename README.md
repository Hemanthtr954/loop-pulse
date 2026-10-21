# Loop Pulse

Engineering insights from a repository's git history: who is doing the work, **how fragile the
team's knowledge of the code it is changing is**, how activity is trending, and a short brief
written by an LLM whose every number is checked against the data before you see it.

- **Git-native integration.** Public GitHub repos are mirrored as bounded, shallow, bare clones
  and mined with `git log`: no token, no REST rate limit, file-level signals for free. GitHub's
  REST API is an optional second source for reviews and time-to-merge.
- **Headline metric: knowledge risk.** Truck factor of the period, ownership concentration,
  single-author hotspots, per-directory owners.
- **A brief you can audit.** The model only sees numbered facts; a guard rejects any draft that
  cites a missing fact or states a number its cited facts do not contain; confidence is capped
  by how much data there is. Works with no LLM key (deterministic narrator), with Anthropic,
  or with any OpenAI-compatible endpoint.

Repository: https://github.com/Hemanthtr954/loop-pulse

## 60-second quickstart

```bash
git clone https://github.com/Hemanthtr954/loop-pulse && cd loop-pulse
cp .env.example .env          # optional: everything has a default
docker compose up --build     # API + dashboard on http://localhost:8080
```

Open <http://localhost:8080> for the dashboard and <http://localhost:8080/docs> for the API.
On first start the tracked repos (default `fastify/fastify`, `expressjs/express`) are cloned;
that takes a few seconds per repo.

Without Docker (Node ≥ 22.13 and git on PATH):

```bash
npm ci && npm --prefix web ci
npm run build && npm start     # or: npm run dev (API only, with watch; UI via npm --prefix web run dev)
```

## Try it

```bash
B=http://localhost:8080/v1/repos/fastify/fastify

curl -s "$B/insights/contributors?from=2026-07-01&to=2026-10-01&sort=churn&limit=5"
curl -s "$B/insights/knowledge-risk"                      # default: last 90 days
curl -s "$B/insights/activity?from=2026-07-01"            # weekly series + previous period
curl -s "$B/narrative"                                    # brief, hypothesis, confidence, evidence
curl -s -i "$B/insights/contributors" -H 'If-None-Match: W/"…"'   # → 304 when unchanged

curl -s -X POST localhost:8080/v1/repos -H 'content-type: application/json' \
     -H "x-api-key: $API_KEY" -d '{"owner":"pallets","name":"flask"}'   # → 202 + Location (allowlisted in .env.example)
```

Every insight response is `{ meta, data }`; `meta` carries the resolved period, the data
version, and the definition of every metric in the payload. Errors are RFC 9457
`application/problem+json`.

| Endpoint | What it returns |
|---|---|
| `GET /v1/repos`, `GET /v1/repos/{owner}/{name}` | Registered repos, sync state, available history |
| `POST /v1/repos`, `POST /v1/repos/{o}/{n}/sync` | Register / refresh (API key if `API_KEY` set; allowlisted) |
| `GET …/insights/contributors` | Commits, churn, files, merged PRs, co-authorship, newcomers per author |
| `GET …/insights/knowledge-risk` | Truck factor, concentration (top share, HHI, effective contributors), hotspots, areas |
| `GET …/insights/activity` | Weekly buckets, weekend share, previous-period deltas, contributors who went quiet, newcomers |
| `GET …/insights/reviewers` | Reviews, approvals, changes requested, review-load balance (`GITHUB_TOKEN`) |
| `GET …/insights/flow` | Time to merge / first review (p50, p90), unreviewed merges, stale PRs (`GITHUB_TOKEN`) |
| `GET …/narrative` | Headline, summary, findings with evidence ids, hypothesis, calibrated confidence, evidence chain |

Common query parameters: `from`, `to` (`YYYY-MM-DD` or ISO datetime with offset; `[from, to)`,
default last 90 days), `includeBots`, `limit`, `sort`.

## The metric, and why

**Knowledge risk** answers: *for the code that actually changed in this period, how many people
would have to disappear before most of it has nobody who recently worked on it?*

- An author *knows* a file if they wrote ≥ 25 % of its churn in the period.
- **Truck factor**: greedily remove the author who knows the most still-known files until more
  than 50 % of changed files have no knower (after Avelino et al., 2016). TF = 1 means one
  resignation orphans most of the active code.
- **Concentration**: top author's churn share, the Herfindahl–Hirschman index of shares, and
  1/HHI as "effective contributors" — it reads like a headcount.
- **Hotspots / areas**: the most-changed files and directories with their owners; a hotspot
  with one author is a *silo*.

Commit leaderboards reward volume. Knowledge risk tells a lead where the team is one departure,
holiday or reorg away from slowing down, and every repo already has the data. Contributors,
activity, reviewers and flow are there for context and for the narrative's root-cause hypotheses
(for example, "commits fell 55 %, and 76 % of the drop is one previously central author going quiet").

**Counting rules** (also returned in `meta.definitions`): commits are non-merge commits on the
default branch placed by committer date; churn is lines added + deleted excluding generated or
vendored files (lockfiles, `dist/`, `vendor/`, minified bundles, snapshots); renames are credited
to the new path; bots are excluded unless `includeBots=true`; e-mail addresses are never returned.

## Configuration

All settings are environment variables, validated at start-up; see [`.env.example`](.env.example).
The important ones: `TRACKED_REPOS`, `ALLOWED_REPOS` / `ALLOW_ANY_PUBLIC_REPO`,
`SYNC_LOOKBACK_DAYS` (default 365), `SYNC_INTERVAL_MINUTES` (default 30), `GITHUB_TOKEN`
(optional, read-only), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` + `OPENAI_BASE_URL` (optional),
`API_KEY` (protects writes).

## Development

```bash
npm test            # 91 tests: parser, scripted git repo end to end, API, guard, GitHub, security
npm run eval        # narrative evals: 6 planted-story cases × rules narrator + 2 adversaries
npm run eval -- --provider anthropic     # same suite against a live model
npm run typecheck
npm run verify:git -- http://localhost:8080 fastify/fastify ./data/git/fastify/fastify.git 2026-07-01 2026-10-01
./scripts/smoke.sh http://localhost:8080 fastify/fastify
```

## Documents

- [`NOTES.md`](NOTES.md) — submission notes: how to run, architecture tour, next steps, AI use
- [`CREATE.md`](CREATE.md) — how the project was planned and built
- [`docs/specs/`](docs/specs) — one spec per task
- [`docs/FINAL_REPORT.md`](docs/FINAL_REPORT.md) — what was built and how it was verified
