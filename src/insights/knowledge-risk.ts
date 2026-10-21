import type { Db } from '../db/database.js';
import { commitScope, hhi, round, share, type InsightQuery } from './query.js';

/** An author "knows" a file if they wrote at least this share of its churn in the period. */
export const KNOWER_MIN_SHARE = 0.25;
/** The truck factor counts removals until more than this share of files has no knower. */
export const ORPHAN_THRESHOLD = 0.5;

export interface AuthorRef {
  id: string;
  name: string;
  login: string | null;
}

export interface KnowledgeRiskResult {
  filesTouched: number;
  truckFactor: number | null;
  /** Authors removed by the greedy algorithm, in order, with the files they alone covered. */
  truckFactorAuthors: (AuthorRef & { filesKnown: number })[];
  concentration: {
    topAuthor: AuthorRef | null;
    topShare: number;
    hhi: number;
    effectiveContributors: number | null;
  };
  hotspots: {
    path: string;
    churn: number;
    commits: number;
    authors: number;
    topAuthor: AuthorRef;
    topAuthorShare: number;
    silo: boolean;
  }[];
  areas: {
    area: string;
    churn: number;
    files: number;
    authors: number;
    topAuthor: AuthorRef;
    topAuthorShare: number;
  }[];
}

interface Row {
  path: string;
  author_id: number;
  churn: number;
  commits: number;
}

export function computeKnowledgeRisk(db: Db, q: InsightQuery, opts: { hotspots?: number; areas?: number } = {}): KnowledgeRiskResult {
  const scope = commitScope(q);
  const rows = db
    .prepare(
      `SELECT f.path, c.author_id, SUM(f.additions + f.deletions) AS churn, COUNT(*) AS commits
       FROM commits c JOIN authors a ON a.id = c.author_id
       JOIN file_changes f ON f.repo_id = c.repo_id AND f.sha = c.sha
       WHERE ${scope.sql} AND c.is_merge = 0 AND f.generated = 0
       GROUP BY f.path, c.author_id`,
    )
    .all(...scope.params) as unknown as Row[];

  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const authors = loadAuthors(db, authorIds);

  // Per-file contributions. Binary-only files have zero churn; fall back to commit counts.
  const byFile = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byFile.get(r.path);
    if (list) list.push(r);
    else byFile.set(r.path, [r]);
  }
  const knowers = new Map<string, Set<number>>();
  const fileStats: { path: string; churn: number; commits: number; authors: number; top: Row; topShare: number }[] = [];
  const churnByAuthor = new Map<number, number>();

  for (const [path, list] of byFile) {
    const churn = list.reduce((s, r) => s + r.churn, 0);
    const commits = list.reduce((s, r) => s + r.commits, 0);
    const weight = (r: Row) => (churn > 0 ? r.churn : r.commits);
    const total = churn > 0 ? churn : commits;
    const top = list.reduce((best, r) => (weight(r) > weight(best) || (weight(r) === weight(best) && r.author_id < best.author_id) ? r : best));
    const set = new Set<number>();
    for (const r of list) if (share(weight(r), total) >= KNOWER_MIN_SHARE) set.add(r.author_id);
    set.add(top.author_id);
    knowers.set(path, set);
    fileStats.push({ path, churn, commits, authors: list.length, top, topShare: share(weight(top), total) });
    for (const r of list) churnByAuthor.set(r.author_id, (churnByAuthor.get(r.author_id) ?? 0) + r.churn);
  }

  const tf = truckFactor(knowers);
  const totalChurn = [...churnByAuthor.values()].reduce((s, v) => s + v, 0);
  const shares = [...churnByAuthor.values()].map((v) => share(v, totalChurn));
  const topEntry = [...churnByAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const h = hhi(shares);

  const ref = (id: number): AuthorRef => authors.get(id)!;

  return {
    filesTouched: byFile.size,
    truckFactor: tf.value,
    truckFactorAuthors: tf.removed.map((r) => ({ ...ref(r.authorId), filesKnown: r.files })),
    concentration: {
      topAuthor: topEntry ? ref(topEntry[0]) : null,
      topShare: round(topEntry ? share(topEntry[1], totalChurn) : 0),
      hhi: round(h),
      effectiveContributors: h > 0 ? round(1 / h, 2) : null,
    },
    hotspots: fileStats
      .sort((a, b) => b.churn - a.churn || b.commits - a.commits || a.path.localeCompare(b.path))
      .slice(0, opts.hotspots ?? 10)
      .map((f) => ({
        path: f.path,
        churn: f.churn,
        commits: f.commits,
        authors: f.authors,
        topAuthor: ref(f.top.author_id),
        topAuthorShare: round(f.topShare),
        silo: f.authors === 1,
      })),
    areas: computeAreas(rows, ref).slice(0, opts.areas ?? 10),
  };
}

/**
 * Greedy truck factor: repeatedly remove the author who knows the most still-known files,
 * until more than ORPHAN_THRESHOLD of files have no knower. O(A · K) for A authors and
 * K (file, knower) pairs.
 */
export function truckFactor(knowers: Map<string, Set<number>>): { value: number | null; removed: { authorId: number; files: number }[] } {
  const totalFiles = knowers.size;
  if (totalFiles === 0) return { value: null, removed: [] };
  const remaining = new Map([...knowers].map(([path, set]) => [path, new Set(set)]));
  const removed: { authorId: number; files: number }[] = [];
  let orphaned = 0;

  while (orphaned / totalFiles <= ORPHAN_THRESHOLD) {
    const counts = new Map<number, number>();
    for (const set of remaining.values()) for (const id of set) counts.set(id, (counts.get(id) ?? 0) + 1);
    const next = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (!next) break;
    removed.push({ authorId: next[0], files: next[1] });
    for (const [path, set] of remaining) {
      set.delete(next[0]);
      if (set.size === 0) {
        remaining.delete(path);
        orphaned++;
      }
    }
  }
  return { value: removed.length, removed };
}

function computeAreas(rows: Row[], ref: (id: number) => AuthorRef): KnowledgeRiskResult['areas'] {
  const areas = new Map<string, { churn: number; files: Set<string>; byAuthor: Map<number, number> }>();
  for (const r of rows) {
    const slash = r.path.indexOf('/');
    const area = slash < 0 ? '(root)' : `${r.path.slice(0, slash)}/`;
    let a = areas.get(area);
    if (!a) areas.set(area, (a = { churn: 0, files: new Set(), byAuthor: new Map() }));
    a.churn += r.churn;
    a.files.add(r.path);
    a.byAuthor.set(r.author_id, (a.byAuthor.get(r.author_id) ?? 0) + r.churn);
  }
  return [...areas.entries()]
    .map(([area, a]) => {
      const [topId, topChurn] = [...a.byAuthor.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]!;
      return {
        area,
        churn: a.churn,
        files: a.files.size,
        authors: a.byAuthor.size,
        topAuthor: ref(topId),
        topAuthorShare: round(share(topChurn, a.churn)),
      };
    })
    .sort((x, y) => y.churn - x.churn || x.area.localeCompare(y.area));
}

function loadAuthors(db: Db, ids: number[]): Map<number, AuthorRef> {
  const map = new Map<number, AuthorRef>();
  if (!ids.length) return map;
  const stmt = db.prepare('SELECT id, public_id, name, login FROM authors WHERE id = ?');
  for (const id of ids) {
    const r = stmt.get(id) as { id: number; public_id: string; name: string; login: string | null };
    map.set(r.id, { id: r.public_id, name: r.name, login: r.login });
  }
  return map;
}
