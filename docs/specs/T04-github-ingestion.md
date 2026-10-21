# T04 — GitHub REST ingestion (pull requests and reviews)

## Goal
Add what git cannot see — who reviewed what, and how long work waited — without letting
REST usage grow with query volume.

## Design
- Enabled only when `GITHUB_TOKEN` is configured (a fine-grained token with public read
  access is enough). Without it, review/flow endpoints answer `409` with a problem document
  that says how to enable them; everything else works.
- `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc&per_page=100`, paging
  until `updated_at` falls below the stored cursor (first sync: the horizon). Upserts PRs.
- For each PR seen in this sync: `GET /repos/{o}/{r}/pulls/{n}/reviews?per_page=100`
  (paged), concurrency 4. Self-reviews and `PENDING` reviews are ignored.
  `first_review_at` = earliest non-author review.
- Bounded by `GITHUB_MAX_PRS_PER_SYNC`; the cursor only advances past fully processed PRs,
  so an interrupted sync resumes where it stopped.
- **Rate limits**: reads `x-ratelimit-remaining/reset`; on exhaustion, or a 403/429 with
  `retry-after`, the sync stops cleanly and records `github_status='rate_limited until …'`.
  Requests carry `If-None-Match` for the first page; a `304` costs no quota.
- Every request has a timeout (`AbortSignal.timeout`), a fixed base URL, and a
  `User-Agent`. The token is sent only in the `Authorization` header and never logged.

## Interface
`GithubClient.paginate(path, params)` is an async generator over pages, following `Link:
rel="next"`, which keeps memory flat and makes the stop-early rule a plain `break`.

## Acceptance criteria (fixture-verified)
- Pagination follows `Link` headers and stops at the cursor.
- Rate-limit exhaustion stops without throwing and is reported in `GET /v1/repos/...`.
- Self-reviews are not counted.

## Limitation
The build environment could not reach `api.github.com`; this source is verified against fixtures
shaped like the documented API responses, not against the live API.
