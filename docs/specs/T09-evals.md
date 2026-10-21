# T09 — Evaluation harness

## Goal
A suite you would run before changing the prompt or swapping a model: `npm run eval`
(offline, deterministic) and `npm run eval -- --provider anthropic` (live, when a key is set).

## Cases
`evals/cases/*.json` — each case is an insight bundle with a planted story and expectations:

| Case | Planted story | Expected |
|---|---|---|
| `departure-drop` | Commits fall 55 %; the previous top author has 0 commits now | hypothesis cites the departure facts; confidence ≥ 0.5 |
| `healthy-balanced` | Flat activity, TF 6, low HHI | no alarmist hypothesis (null or confidence ≤ 0.5) |
| `single-owner-silo` | One author ≈ 80 % of churn, TF 1 | a finding cites truck factor fact |
| `tiny-sample` | 4 commits in the period | confidence ≤ 0.4; caveat about sample size |
| `bot-heavy` | 60 % of commits are bots | finding mentions bot share fact |
| `spike-week` | one week at 5× median | finding cites the spike fact |

## Graders (per case, per provider)
1. **Schema validity** — output parses.
2. **Citation validity** — every cited ID exists.
3. **Numeric faithfulness** — every number in prose is backed by a cited fact.
4. **Signal recall** — the planted signal's key facts are cited somewhere.
5. **Calibration** — confidence lies within the case's expected band.
6. **Restraint** — no hypothesis above 0.5 on the healthy case.

## Guard evals
Two adversarial fake providers run through the real pipeline: `hallucinator` (changes a
number) and `fabricator` (cites `F999`). Pass = the pipeline never returns their output
unguarded (`degraded: true` or repaired).

## Output
A table on stdout and `evals/report.json`; exit code 1 if any grader fails, so it can gate CI.
