# T06 — Insight engine

All insights take a **period** `[from, to)` (UTC; `from` inclusive, `to` exclusive). Default
is the last 90 days. A period must lie inside the synced horizon; otherwise `422` explains
the available range. Bots are excluded unless `includeBots=true`.

## 1. Contributors (`/insights/contributors`)
Per author: `commits` (non-merge), `additions`, `deletions`, `churn` (excluding generated
paths), `filesTouched` (distinct), `activeDays`, `mergedPrs` (distinct PR numbers on their
squash commits), `coAuthored`, `firstCommitInHorizon` (marks newcomers). Sortable by
`commits | churn | filesTouched | mergedPrs`, `limit` 1–100. Totals are returned alongside
items so shares add up and can be checked.

## 2. Knowledge risk (`/insights/knowledge-risk`) — the headline metric
**What it means.** For the code that actually changed in the period, how concentrated is
the knowledge of it?

- **File knowers**: for each non-generated file touched in the period, an author "knows" it
  if they contributed ≥ 25 % of its churn in the period (or are its only author).
- **Truck factor** (greedy, after Avelino et al., 2016): repeatedly remove the author who
  knows the most still-covered files; the truck factor is the number removed before more
  than 50 % of touched files have no remaining knower. TF = 1 means one departure orphans
  most of the active code.
- **Concentration**: top author's share of churn, and the Herfindahl–Hirschman index of
  churn shares (0–1; above 0.25 is highly concentrated). The **effective number of
  contributors** = 1/HHI is reported because it reads like a headcount.
- **Hotspots**: top files by churn, with author count and top-author share; a hotspot with a
  single author is a *silo*.
- **Areas**: top-level directories with churn, author count, top owner and share.

**Why this metric.** Commit leaderboards reward volume. Knowledge risk tells a lead where
the team is one resignation, holiday or reorg away from slowing down, and it is computable
from data every repo already has.

## 3. Activity (`/insights/activity`)
Weekly buckets (ISO weeks, UTC): commits, active authors, churn, merged PRs; weekend share
(author local time); and the same totals for the previous period of equal length when
the horizon covers it, as absolute and relative deltas.

## 4. Reviews (`/insights/reviewers`) — needs `GITHUB_TOKEN`
Per reviewer: reviews submitted, approvals, changes requested, distinct PRs reviewed;
review-load share and HHI across reviewers.

## 5. Flow (`/insights/flow`) — needs `GITHUB_TOKEN`
PRs merged in the period, time-to-merge and time-to-first-review (p50/p90, hours),
PRs merged without any review, open PRs idle > 14 days.

## Performance
Aggregation is done in SQL with indexed range scans; per-file knower computation is a single
grouped query plus a greedy loop over authors that is O(A·F) with A authors and F files,
both bounded by the period; there is no per-commit loop in JS. Results are memoised per
`(repo, data_version, query)` in a bounded LRU.

## Acceptance criteria
- Sum of per-author commits equals the period total; shares sum to 1 ± 1e-9.
- Truck factor matches hand-computed values on fixture scenarios (1, 2 and "everyone").
- Empty period returns 200 with zeroed totals and empty lists, not an error.
