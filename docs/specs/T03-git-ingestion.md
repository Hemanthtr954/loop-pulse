# T03 — Git ingestion

## Goal
Turn a public GitHub repository's default branch into rows in `commits`, `file_changes`,
`co_authors` and `authors`, cheaply, safely and correctly.

## Design
1. **Mirror**: `git clone --bare --single-branch --shallow-since=<horizon> <url>` into
   `$DATA_DIR/git/<owner>/<name>.git`; later syncs run
   `git fetch --shallow-since=<horizon> origin +HEAD:refs/heads/<branch>` (with
   `--prune`). The mirror is bounded by the horizon, so disk and time stay proportional to
   one year of activity, not the repo's lifetime.
2. **Skip if unchanged**: if the branch head SHA equals `repos.head_sha` and the horizon has
   not moved by more than a day, ingestion is skipped.
3. **Stream, don't buffer**: `git log <branch> --numstat --format=<record>` is spawned and
   parsed line by line from stdout (`readline`), inserting rows in batches inside one
   transaction. No full-output buffer, so large histories never block the event loop or
   blow up memory.
4. **Replace in a transaction**: the repo's commit rows are replaced atomically on each
   changed sync. This keeps force-pushed or rewritten history from lingering and keeps the
   code path single (no incremental reconciliation bugs). Cost is O(commits in horizon).

## Record format
`%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)`
followed by numstat lines `<adds>\t<dels>\t<path>`. `%aN`/`%aE` honour `.mailmap`.

## Correctness rules
- **Shallow boundary commits** (listed in the mirror's `shallow` file) have no parent in
  the clone, so git reports their whole tree as added. They are stored with
  `stats_complete=0` and zero line stats, and the queryable window starts after the horizon.
  Without this rule, one boundary commit adds the entire codebase to someone's line count.
- **Merge commits** (more than one parent) are stored with `is_merge=1`; they are excluded
  from commit and line counts (their changes are already counted on the merged commits).
- **Binary files** (`-\t-\tpath`) count as files changed with 0 lines.
- **Renames** (`old => new`, `{a => b}/c`) are normalised to the new path.
- **Generated / vendored paths** (lockfiles, `dist/`, `vendor/`, `node_modules/`,
  `*.min.js`, `*.map`, snapshots) are stored but flagged and excluded from *churn* metrics,
  because one `package-lock.json` regeneration otherwise outweighs a month of real work.
- **PR number**: from a squash subject `… (#123)` or `Merge pull request #123`.
- **Time**: the period filter uses committer date (when it landed on the branch); weekday
  analysis uses author date in the author's own UTC offset.

## Security
- Owner/name validated with GitHub's naming rules before anything else; the URL is built
  from a fixed host (`https://github.com/`), so callers cannot point the service at internal
  hosts (no SSRF) or local paths.
- `git` is invoked via `spawn` with an argument array (no shell), `GIT_TERMINAL_PROMPT=0`,
  `-c protocol.allow=never -c protocol.https.allow=always`, a wall-clock timeout, and a
  stderr cap. Private or missing repos fail fast instead of prompting for credentials.

## Acceptance criteria
- On a scripted fixture repo with known authors/dates/lines, ingested counts equal the
  ground truth exactly (including renames, binary files, merge commits, co-authors).
- On a real repo, `commits` in a window equals
  `git rev-list --count --no-merges --since --until` over the same window.
