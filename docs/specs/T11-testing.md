# T11 — Tests and verification

## What is tested, and why those parts
Tests concentrate where a bug would silently produce wrong numbers or unsafe behaviour:

| Area | Why it matters | Tests |
|---|---|---|
| Git log parser | Every number starts here; renames, binaries, merges, trailers, boundary commits are easy to get wrong | unit tests on literal git output; integration test on a scripted repo with known ground truth |
| Period & repo validation | Untrusted input; SSRF/injection boundary | unit tests incl. hostile inputs (`../`, `owner/name;rm`, URLs) |
| Knowledge-risk math | The headline metric must be explainable and exact | hand-computed fixtures for TF, HHI, shares |
| Narrative guard | The evidence chain is only as good as its validator | hallucinated numbers, unknown IDs, uncited claims, rounding tolerance |
| API semantics | Contract the reviewer will curl | inject tests for status codes, ETag/304, problem+json, auth |
| GitHub client | Can't hit the live API here | pagination, cursor stop, rate-limit stop with stubbed `fetch` |

Not tested on purpose: React rendering details, pino formatting, third-party libraries.

## Verification against source data
A script (`scripts/verify-against-git.sh`) compares API totals for a window with raw
`git rev-list --count --no-merges` and `git log --numstat` sums computed independently from
the mirror. Run against real repos and recorded in the final report.
