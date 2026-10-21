# T08 — Grounded narrative

`GET /v1/repos/{owner}/{name}/narrative?from&to`

## Pipeline
1. **Fact sheet** — the insight results for the period (and previous period) are flattened
   into numbered facts: `{id:"F7", statement:"Top author A wrote 41.2% of churn", value:0.412,
   unit:"ratio", source:{path:"/v1/repos/…/insights/knowledge-risk?…", pointer:"/concentration/topShare"}}`.
   Facts are the *only* numbers the model may use. The `source` makes each one re-fetchable.
2. **Signals** — deterministic detectors rank what is notable, each with a strength 0–1 and
   the fact IDs it rests on: concentration, low truck factor, single-author hotspots,
   activity change vs previous period, departed or newly arrived contributors, weekly spike,
   weekend work share, bot share, review-load concentration, time-to-merge change.
3. **Generation** — the provider receives facts + signals and must return:
   ```json
   {"headline": "...", "summary": "2–4 sentences",
    "findings": [{"claim": "...", "evidence": ["F3","F7"]}],
    "hypothesis": {"statement": "...", "evidence": ["F2","F9"], "confidence": 0.6} | null,
    "caveats": ["..."]}
   ```
   Anthropic uses forced tool use with a JSON schema; OpenAI-compatible endpoints use JSON
   mode. Temperature 0.2, 20 s timeout.
4. **Guard** — rejects output if: schema invalid; any cited ID is unknown; a finding or
   hypothesis cites nothing; a number in a claim does not match (after rounding) a value in
   the facts *that claim cites*; a number in the summary is not in any cited fact. On
   rejection the model gets one repair attempt with the violations listed; if that fails,
   the deterministic `rules` narrator answers and `degraded: true` plus the reason is
   returned.
5. **Calibrated confidence** — `confidence = min(modelConfidence, ceiling)` where
   `ceiling = 0.3 + 0.6 × sufficiency` and sufficiency is the product of
   `√min(1, commits/100)`, `√min(1, activeWeeks/8)` and `√min(1, authors/5)` — a product, so
   one thin dimension limits the whole. A hypothesis that cites no fact behind a strong
   (≥ 0.5) causal signal is capped at 0.5. Both numbers and the rationale are returned.
6. **Evidence chain** — the response resolves every cited fact ID to its statement, value
   and source link.

## Caching and cost
Narratives are cached in SQLite by `sha256(repo, period, data_version, provider, model,
PROMPT_VERSION)`, so a narrative is generated once per data change. `PROMPT_VERSION` is bumped
whenever the prompt, facts, signals or calibration change, which invalidates the cache. The route has its own rate limit.

## Providers
`rules` (deterministic, default when no key), `anthropic`, `openai` (any compatible base
URL). Providers implement one method: `generate(input) → unknown`; parsing and guarding are
shared, so a new provider cannot bypass validation.

## Acceptance criteria
- With no key configured, the endpoint returns a valid, guarded narrative.
- A fake provider that invents a number or cites `F999` is rejected, repaired or degraded —
  never returned as-is (eval + unit test).
