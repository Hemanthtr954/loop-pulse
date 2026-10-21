/**
 * Forward-only, versioned migrations. Timestamps are epoch milliseconds (UTC).
 */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE repos (
        id              INTEGER PRIMARY KEY,
        owner           TEXT NOT NULL,
        name            TEXT NOT NULL,
        slug_key        TEXT NOT NULL UNIQUE,          -- lower(owner/name)
        default_branch  TEXT,
        created_at      INTEGER NOT NULL,
        sync_status     TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | ready | error
        sync_error      TEXT,
        last_synced_at  INTEGER,
        horizon         INTEGER,                        -- earliest instant with complete data
        head_sha        TEXT,
        data_version    INTEGER NOT NULL DEFAULT 0,
        github_cursor   INTEGER,                        -- max PR updated_at fully processed
        github_status   TEXT,
        github_etag     TEXT,                           -- ETag of the newest PR list page
        github_synced_at INTEGER
      );

      CREATE TABLE authors (
        id        INTEGER PRIMARY KEY,
        repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        key       TEXT NOT NULL,                        -- lower(mailmapped email)
        public_id TEXT NOT NULL,                        -- sha256(key) prefix, safe to expose
        name      TEXT NOT NULL,
        login     TEXT,
        is_bot    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (repo_id, key)
      );

      CREATE TABLE commits (
        repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha            TEXT NOT NULL,
        author_id      INTEGER NOT NULL REFERENCES authors(id),
        committed_at   INTEGER NOT NULL,
        authored_at    INTEGER NOT NULL,
        author_tz_min  INTEGER NOT NULL,               -- author's UTC offset in minutes
        additions      INTEGER NOT NULL,
        deletions      INTEGER NOT NULL,
        churn          INTEGER NOT NULL,               -- additions+deletions excluding generated paths
        files_changed  INTEGER NOT NULL,
        is_merge       INTEGER NOT NULL,
        pr_number      INTEGER,
        stats_complete INTEGER NOT NULL,
        PRIMARY KEY (repo_id, sha)
      ) WITHOUT ROWID;
      CREATE INDEX commits_by_time ON commits (repo_id, committed_at);
      CREATE INDEX commits_by_author ON commits (repo_id, author_id, committed_at);

      CREATE TABLE file_changes (
        repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha        TEXT NOT NULL,
        path       TEXT NOT NULL,
        additions  INTEGER NOT NULL,
        deletions  INTEGER NOT NULL,
        generated  INTEGER NOT NULL
      );
      CREATE INDEX file_changes_by_commit ON file_changes (repo_id, sha);

      CREATE TABLE co_authors (
        repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha       TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        PRIMARY KEY (repo_id, sha, author_id)
      ) WITHOUT ROWID;

      CREATE TABLE pull_requests (
        repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number          INTEGER NOT NULL,
        author_login    TEXT,
        author_is_bot   INTEGER NOT NULL,
        state           TEXT NOT NULL,
        draft           INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        merged_at       INTEGER,
        closed_at       INTEGER,
        first_review_at INTEGER,
        reviews_pending INTEGER NOT NULL DEFAULT 1,     -- reviews not fetched since last update
        PRIMARY KEY (repo_id, number)
      ) WITHOUT ROWID;
      CREATE INDEX prs_by_merged ON pull_requests (repo_id, merged_at);
      CREATE INDEX prs_pending ON pull_requests (repo_id, reviews_pending, updated_at);

      CREATE TABLE reviews (
        repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        id             INTEGER NOT NULL,
        pr_number      INTEGER NOT NULL,
        reviewer_login TEXT NOT NULL,
        reviewer_is_bot INTEGER NOT NULL,
        state          TEXT NOT NULL,
        submitted_at   INTEGER NOT NULL,
        PRIMARY KEY (repo_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX reviews_by_time ON reviews (repo_id, submitted_at);

      CREATE TABLE narratives (
        cache_key  TEXT PRIMARY KEY,
        repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        body_json  TEXT NOT NULL
      );
    `,
  },
];
