# T02 — Storage schema and migrations

## Goal
Persist everything fetched upstream so that queries never hit GitHub, and so repeated
queries are answered by indexed SQL instead of re-parsing history.

## Decision
SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), WAL mode, `foreign_keys=ON`,
`busy_timeout=5000`. One file at `$DATA_DIR/pulse.db`. Rationale: zero-ops, transactional,
fast enough for single-node analytics over a year of history; the queries are plain SQL so
moving to Postgres is a driver swap, not a redesign.

## Schema (v1)

```
repos(id PK, owner, name, default_branch, created_at,
      sync_status, sync_error, last_synced_at, horizon, head_sha,
      data_version, github_cursor, github_status)            UNIQUE(owner,name)
authors(id PK, repo_id FK, key, name, login, is_bot)        UNIQUE(repo_id,key)
commits(sha, repo_id FK, author_id FK, committed_at, authored_at, author_tz_offset_min,
        additions, deletions, files_changed, is_merge, pr_number, stats_complete)
        PK(repo_id, sha); INDEX(repo_id, committed_at)
file_changes(repo_id, sha, path, additions, deletions)     INDEX(repo_id, sha), INDEX(repo_id, path)
co_authors(repo_id, sha, author_id)
pull_requests(repo_id, number, author_login, state, draft, created_at, updated_at,
              merged_at, closed_at, first_review_at)        PK(repo_id, number)
reviews(repo_id, id, pr_number, reviewer_login, state, submitted_at) PK(repo_id,id)
narratives(cache_key PK, repo_id, created_at, body_json)
schema_migrations(version)
```

- Timestamps are stored as integer epoch milliseconds (UTC). Range filters are integer
  comparisons on an index.
- Author identity key = lower-cased, `.mailmap`-resolved e-mail. E-mails are **not**
  exposed by the API; the public id is a 12-char SHA-256 prefix of the key. A GitHub login
  is derived only from `…@users.noreply.github.com` addresses.
- `data_version` increments whenever a sync changes stored data; it feeds ETags and cache
  keys, so caches can never serve data older than the database.

## Acceptance criteria
- Migrations are idempotent and versioned; opening an existing DB is a no-op.
- Re-ingesting the same history is a no-op in effect (same rows, same `data_version`).
- Every insight query uses `(repo_id, committed_at)` or `(repo_id, sha)` indexes —
  verified with `EXPLAIN QUERY PLAN` in a test.
