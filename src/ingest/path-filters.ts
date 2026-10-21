/**
 * Paths whose line counts measure tooling, not people: lockfiles, build output, vendored
 * code, minified bundles, snapshots. They are stored but excluded from churn metrics.
 */
const GENERATED_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'go.sum',
  'uv.lock',
]);

const GENERATED_DIRS = /(^|\/)(node_modules|vendor|dist|coverage|\.yarn|__snapshots__|third_party)\//i;
const GENERATED_SUFFIX = /\.(min\.js|min\.css|map|snap|lock)$/i;

export function isGeneratedPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return GENERATED_FILES.has(base) || GENERATED_DIRS.test(path) || GENERATED_SUFFIX.test(path);
}

const BOT_RE = /(\[bot\]|^dependabot|^renovate|^github-actions|^greenkeeper|^snyk-bot|^mergify|^allcontributors|-bot$)/i;

export function isBotIdentity(name: string, emailOrLogin: string): boolean {
  return BOT_RE.test(name) || BOT_RE.test(emailOrLogin.split('@')[0] ?? '') || /\[bot\]@/i.test(emailOrLogin);
}

/** 12345+octocat@users.noreply.github.com → "octocat" */
export function loginFromNoreply(email: string): string | null {
  const m = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?)@users\.noreply\.github\.com$/i.exec(email);
  return m ? m[1]! : null;
}

/** "fix: x (#123)" or "Merge pull request #123 from a/b" → 123 */
export function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d{1,7})\)\s*$/.exec(subject) ?? /^Merge pull request #(\d{1,7})\b/.exec(subject);
  return m ? Number(m[1]) : null;
}
