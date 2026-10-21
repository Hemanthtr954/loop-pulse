# T05 — Sync orchestration and background worker

## Goal
Data is pulled in the background into the local store; HTTP requests only read.

## Design
- `SyncService.sync(repo)` runs git ingestion, then (if enabled) GitHub ingestion, and
  records `sync_status` (`pending → syncing → ready | error`), `last_synced_at`,
  `sync_error` (sanitised, no URLs with credentials, capped length).
- **Single flight per repo**: concurrent sync requests for the same repo share one promise.
  A global concurrency limit (2) keeps clones from saturating the host.
- **Scheduler**: on boot, every repo in `TRACKED_REPOS` is registered and synced; then every
  `SYNC_INTERVAL_MINUTES` (± 10 % jitter) each repo is refreshed. Timers are `unref`'d and
  cleared on shutdown.
- **Readiness**: `/readyz` is 200 once the DB is open. A repo whose first sync has not
  finished answers insight requests with `409` + `Retry-After: 5` and its sync state, so
  clients can poll instead of guessing.
- **Graceful shutdown** on SIGTERM/SIGINT: stop accepting, stop the scheduler, kill child
  git processes, close the DB.

## Acceptance criteria
- Two simultaneous `POST /v1/repos/{o}/{n}/sync` calls start one git process.
- A failing sync records `error` with a readable message and does not crash the process;
  previously ingested data stays queryable.
