/**
 * Cross-checks API numbers against raw git, computed independently of the ingestion code
 * (its own git invocations and parsing; only the definition of "generated path" is shared).
 *
 *   npx tsx scripts/verify-against-git.ts <baseUrl> <owner/name> <mirrorDir> <from> <to>
 *   e.g. npx tsx scripts/verify-against-git.ts http://localhost:8080 fastify/fastify ./data/git/fastify/fastify.git 2026-07-01 2026-10-01
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGeneratedPath } from '../src/ingest/path-filters.js';

const [base, slug, mirror, from, to] = process.argv.slice(2);
if (!base || !slug || !mirror || !from || !to) {
  console.error('usage: verify-against-git.ts <baseUrl> <owner/name> <mirrorDir> <from> <to>');
  process.exit(2);
}

const git = (...args: string[]) => execFileSync('git', ['-C', mirror, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const fromTs = Date.parse(`${from}T00:00:00Z`) / 1000;
const toTs = Date.parse(`${to}T00:00:00Z`) / 1000;
const boundary = new Set(existsSync(join(mirror, 'shallow')) ? readFileSync(join(mirror, 'shallow'), 'utf8').split('\n').filter(Boolean) : []);

// One pass over non-merge commits: committer timestamp, sha, author email, subject, numstat.
const out = git('log', 'HEAD', '--no-merges', '--numstat', '--format=@@%ct %H %aE %s');
let commits = 0;
let additions = 0;
let deletions = 0;
const authors = new Set<string>();
const prs = new Set<string>();
let inRange = false;
let skipStats = false;
for (const line of out.split('\n')) {
  if (line.startsWith('@@')) {
    const [ts, sha, email, ...subject] = line.slice(2).split(' ');
    const t = Number(ts);
    inRange = t >= fromTs && t < toTs;
    skipStats = boundary.has(sha!);
    if (!inRange) continue;
    commits++;
    authors.add(email!.toLowerCase());
    const pr = /\(#(\d+)\)\s*$/.exec(subject.join(' '));
    if (pr) prs.add(pr[1]!);
    continue;
  }
  if (!inRange || skipStats || !line.trim()) continue;
  const [a, d, ...p] = line.split('\t');
  let path = p.join('\t');
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (brace) path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/');
  else if (path.includes(' => ')) path = path.split(' => ')[1]!;
  if (a === '-' || isGeneratedPath(path)) continue;
  additions += Number(a);
  deletions += Number(d);
}

const res = await fetch(`${base}/v1/repos/${slug}/insights/contributors?from=${from}&to=${to}&includeBots=true&limit=1`);
if (!res.ok) throw new Error(`API ${res.status}`);
const api = (await res.json()) as { data: { totals: Record<string, number> } };
const t = api.data.totals;

const rows: [string, number, number][] = [
  ['commits (non-merge, incl. bots)', commits, t.commits!],
  ['authors (distinct e-mails)', authors.size, t.authors!],
  ['lines added (non-generated)', additions, t.additions!],
  ['lines deleted (non-generated)', deletions, t.deletions!],
];
let ok = true;
console.log(`${slug} ${from} → ${to}`);
for (const [label, g, a] of rows) {
  const match = g === a;
  ok &&= match;
  console.log(`  ${match ? '✓' : '✗'} ${label.padEnd(34)} git=${String(g).padStart(7)}  api=${String(a).padStart(7)}`);
}
console.log(`  · squash PR numbers in subjects: git=${prs.size} (API mergedPrs=${t.mergedPrs} also counts merge commits)`);
process.exit(ok ? 0 : 1);
