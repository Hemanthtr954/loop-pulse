/**
 * Captures API responses from a running instance into web/snapshot.json so the dashboard can
 * be built as one self-contained HTML file (npm --prefix web run build:snapshot).
 *
 *   npx tsx scripts/capture-snapshot.ts http://localhost:8080 fastify/fastify,expressjs/express
 */
import { writeFileSync } from 'node:fs';

const [base = 'http://localhost:8080', order = ''] = process.argv.slice(2);
const DAY = 86_400_000;
const PRESETS = [30, 90, 180];
const capturedAt = new Date().toISOString();
const to = Math.floor(Date.parse(capturedAt) / DAY) * DAY + DAY; // same rule as the UI
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

const responses: Record<string, unknown> = {};
async function grab(path: string): Promise<unknown> {
  let res = await fetch(base + path);
  while (res.status === 429) {
    // The narrative endpoint is rate limited; honour Retry-After rather than failing.
    const wait = Number(res.headers.get('retry-after') ?? 10);
    console.log(`rate limited, waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(base + path);
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const body = await res.json();
  responses[path] = body;
  return body;
}

const repos = (await grab('/v1/repos')) as { items: { slug: string; sync: { status: string } }[] };
const preferred = order.split(',').filter(Boolean);
repos.items.sort((a, b) => (preferred.indexOf(a.slug) + 1 || 99) - (preferred.indexOf(b.slug) + 1 || 99));
responses['/v1/repos'] = repos;

for (const repo of repos.items.filter((r) => r.sync.status === 'ready')) {
  for (const days of PRESETS) {
    const q = `from=${iso(to - days * DAY)}&to=${iso(to)}`;
    await grab(`/v1/repos/${repo.slug}/insights/contributors?${q}&limit=100`);
    await grab(`/v1/repos/${repo.slug}/insights/knowledge-risk?${q}`);
    await grab(`/v1/repos/${repo.slug}/insights/activity?${q}`);
    await grab(`/v1/repos/${repo.slug}/narrative?${q}`);
  }
}
writeFileSync(new URL('../web/snapshot.json', import.meta.url), JSON.stringify({ capturedAt, responses }));
console.log(`captured ${Object.keys(responses).length} responses at ${capturedAt}`);
