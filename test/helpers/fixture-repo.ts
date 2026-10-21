import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Builds a small git repository with a scripted history whose numbers are known exactly.
 * Expected values are documented in EXPECTED and asserted by the ingestion and API tests.
 */
interface Who {
  name: string;
  email: string;
}

export const ALICE: Who = { name: 'Alice Doe', email: 'alice@example.com' };
export const BOB: Who = { name: 'Bob Roe', email: '1001+bobr@users.noreply.github.com' };
export const CAROL: Who = { name: 'Carol Poe', email: 'carol@example.com' };
export const BOT: Who = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };

/** "now" for tests, chosen so the default 365-day horizon is 2025-06-15. */
export const FIXTURE_NOW = Date.parse('2026-06-15T12:00:00Z');
export const PERIOD = { from: '2026-03-01', to: '2026-06-01' };

export const EXPECTED = {
  commits: 7,
  authors: 3,
  additions: 51,
  deletions: 1,
  churn: 52,
  mergedPrs: 2,
  botCommits: 1,
  byAuthor: {
    'Alice Doe': { commits: 3, churn: 12, filesTouched: 2, mergedPrs: 0 },
    'Bob Roe': { commits: 2, churn: 7, filesTouched: 2, mergedPrs: 1, coAuthored: 1 },
    'Carol Poe': { commits: 2, churn: 33, filesTouched: 1, mergedPrs: 0 },
  },
  weekendCommits: 1,
  filesTouched: 5,
  truckFactor: 2,
  topShare: 33 / 52,
  hhi: (12 / 52) ** 2 + (7 / 52) ** 2 + (33 / 52) ** 2,
};

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';

export function createFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-fixture-'));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, stdio: 'pipe' });
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const append = (path: string, content: string) => writeFileSync(join(dir, path), content, { flag: 'a' });
  const commit = (who: Who, date: string, message: string) => {
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '-m', message], {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: date,
    });
  };

  git(['init', '-q', '-b', 'main']);
  // 1. Before the horizon: never ingested.
  write('src/a.js', lines(100, 'a'));
  write('README.md', lines(5, 'readme'));
  commit(ALICE, '2025-01-10T10:00:00+00:00', 'initial');
  // 2. Inside the horizon, outside the period: becomes the shallow boundary commit.
  write('src/b.js', lines(20, 'b'));
  commit(BOB, '2025-08-01T10:00:00+00:00', 'add b');
  // 3. Sunday 23:00 in UTC-2 = Monday 01:00 UTC → a weekend commit in the author's time.
  append('src/a.js', lines(10, 'a2'));
  commit(ALICE, '2026-03-01T23:00:00-02:00', 'extend a');
  // 4. Squash-merge style subject with a PR number.
  append('src/b.js', lines(5, 'b2'));
  commit(BOB, '2026-03-03T10:00:00+00:00', 'feat: extend b (#12)');
  // 5. Friday 23:30 in UTC-5 = Saturday UTC → *not* a weekend commit in the author's time.
  write('docs/guide.md', lines(30, 'guide'));
  commit(CAROL, '2026-03-06T23:30:00-05:00', `docs: guide\n\nCo-authored-by: ${BOB.name} <${BOB.email}>`);
  // 6. A lockfile (excluded from churn) plus two real lines.
  write('package-lock.json', lines(1000, 'lock'));
  append('src/a.js', lines(2, 'a3'));
  commit(ALICE, '2026-03-10T10:00:00+00:00', 'deps');
  // 7. A binary file: counts as a file, zero lines.
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
  commit(ALICE, '2026-03-11T10:00:00+00:00', 'logo');
  // 8. Rename with a one-line edit: attributed to the new path.
  mkdirSync(join(dir, 'lib'), { recursive: true });
  renameSync(join(dir, 'src/b.js'), join(dir, 'lib/b.js'));
  writeFileSync(join(dir, 'lib/b.js'), readFileSync(join(dir, 'lib/b.js'), 'utf8').replace('b line 1\n', 'b line one\n'));
  commit(BOB, '2026-03-12T10:00:00+00:00', 'move b to lib');
  // 9. A feature branch merged with a merge commit.
  git(['checkout', '-q', '-b', 'feature']);
  append('docs/guide.md', lines(3, 'guide2'));
  commit(CAROL, '2026-03-13T10:00:00+00:00', 'docs: more guide');
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '--no-gpg-sign', 'feature', '-m', 'Merge pull request #20 from carol/feature'], {
    GIT_AUTHOR_NAME: ALICE.name,
    GIT_AUTHOR_EMAIL: ALICE.email,
    GIT_AUTHOR_DATE: '2026-03-14T10:00:00+00:00',
    GIT_COMMITTER_NAME: ALICE.name,
    GIT_COMMITTER_EMAIL: ALICE.email,
    GIT_COMMITTER_DATE: '2026-03-14T10:00:00+00:00',
  });
  // 10. A bot commit.
  write('package.json', '{"name":"fixture"}\n');
  commit(BOT, '2026-03-15T10:00:00+00:00', 'chore(deps): bump');
  // 11. After the period.
  append('src/a.js', lines(1, 'a4'));
  commit(ALICE, '2026-06-05T10:00:00+00:00', 'late change');
  return dir;
}
