/**
 * Streaming parser for:
 *   git log --numstat --format=<LOG_FORMAT>
 * Each commit starts with a header line beginning with RS (\x1e); fields are separated by
 * US (\x1f). Numstat lines follow until the next header.
 */
export const LOG_FORMAT = '%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)';

export interface ParsedFile {
  path: string;
  /** null for binary files */
  additions: number | null;
  deletions: number | null;
}

export interface Person {
  name: string;
  email: string;
}

export interface ParsedCommit {
  sha: string;
  parents: string[];
  author: Person;
  authoredAt: number;
  authorTzMin: number;
  committedAt: number;
  subject: string;
  coAuthors: Person[];
  files: ParsedFile[];
}

const RS = '\x1e';
const US = '\x1f';
const GS = '\x1d';

export class LogParser {
  private current: ParsedCommit | null = null;

  constructor(private readonly emit: (commit: ParsedCommit) => void) {}

  push(line: string): void {
    if (line.startsWith(RS)) {
      this.flush();
      this.current = parseHeader(line.slice(1));
      return;
    }
    if (!line || !this.current) return;
    const file = parseNumstat(line);
    if (file) this.current.files.push(file);
  }

  /** Must be called once after the last line. */
  end(): void {
    this.flush();
  }

  private flush(): void {
    if (this.current) this.emit(this.current);
    this.current = null;
  }
}

function parseHeader(raw: string): ParsedCommit {
  const f = raw.split(US);
  if (f.length < 8) throw new Error(`Malformed git log header (${f.length} fields)`);
  const [sha, parents, aName, aEmail, aDate, cDate, subject, trailers] = f as [string, string, string, string, string, string, string, string];
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error('Malformed commit sha in git log output');
  const authoredAt = Date.parse(aDate);
  const committedAt = Date.parse(cDate);
  if (Number.isNaN(authoredAt) || Number.isNaN(committedAt)) throw new Error(`Malformed date in commit ${sha}`);
  return {
    sha,
    parents: parents ? parents.split(' ') : [],
    author: { name: aName, email: aEmail },
    authoredAt,
    authorTzMin: parseTzOffset(aDate),
    committedAt,
    subject,
    coAuthors: parseCoAuthors(trailers),
    files: [],
  };
}

/** "2026-10-19T23:04:30+02:00" → 120; "...Z" → 0 */
export function parseTzOffset(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

function parseCoAuthors(trailers: string): Person[] {
  const out: Person[] = [];
  for (const value of trailers.split(GS)) {
    const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
    if (m) out.push({ name: m[1] || m[2]!, email: m[2]! });
  }
  return out;
}

function parseNumstat(line: string): ParsedFile | null {
  const first = line.indexOf('\t');
  const second = first < 0 ? -1 : line.indexOf('\t', first + 1);
  if (second < 0) return null;
  const a = line.slice(0, first);
  const d = line.slice(first + 1, second);
  const path = normaliseRenamePath(unquotePath(line.slice(second + 1)));
  if (a === '-' && d === '-') return { path, additions: null, deletions: null };
  const additions = Number(a);
  const deletions = Number(d);
  if (!Number.isInteger(additions) || !Number.isInteger(deletions)) return null;
  return { path, additions, deletions };
}

/**
 * Numstat renders renames as "old => new" or "dir/{old => new}/file". We attribute the change
 * to the new path, which is where the knowledge now lives.
 */
export function normaliseRenamePath(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) {
    const [, prefix, , to, suffix] = braced as unknown as [string, string, string, string, string];
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/g, '/');
  }
  const plain = path.indexOf(' => ');
  return plain >= 0 ? path.slice(plain + 4) : path;
}

/** Undo git's C-style quoting ("a\tb", "\303\251") used for unusual path characters. */
export function unquotePath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
