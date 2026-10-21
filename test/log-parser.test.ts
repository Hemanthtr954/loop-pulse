import { describe, expect, it } from 'vitest';
import { LogParser, normaliseRenamePath, parseTzOffset, unquotePath, type ParsedCommit } from '../src/ingest/git/log-parser.js';
import { isBotIdentity, isGeneratedPath, loginFromNoreply, prNumberFromSubject } from '../src/ingest/path-filters.js';

const RS = '\x1e';
const US = '\x1f';
const sha = (c: string) => c.repeat(40);

function parse(lines: string[]): ParsedCommit[] {
  const out: ParsedCommit[] = [];
  const p = new LogParser((c) => out.push(c));
  lines.forEach((l) => p.push(l));
  p.end();
  return out;
}

const header = (s: string, parents: string, subject: string, trailers = '') =>
  `${RS}${s}${US}${parents}${US}Ann${US}ann@x.io${US}2026-01-02T03:04:05+05:30${US}2026-01-02T00:00:00Z${US}${subject}${US}${trailers}`;

describe('LogParser', () => {
  it('parses headers, numstat lines, binaries and co-author trailers', () => {
    const [c] = parse([
      header(sha('a'), sha('b'), 'fix: thing (#42)', `Bo <bo@x.io>\x1dCy Z <cy@x.io>`),
      '',
      '3\t1\tsrc/x.ts',
      '-\t-\timg/logo.png',
      '',
    ]);
    expect(c).toMatchObject({
      sha: sha('a'),
      parents: [sha('b')],
      author: { name: 'Ann', email: 'ann@x.io' },
      authorTzMin: 330,
      committedAt: Date.parse('2026-01-02T00:00:00Z'),
      subject: 'fix: thing (#42)',
      coAuthors: [
        { name: 'Bo', email: 'bo@x.io' },
        { name: 'Cy Z', email: 'cy@x.io' },
      ],
      files: [
        { path: 'src/x.ts', additions: 3, deletions: 1 },
        { path: 'img/logo.png', additions: null, deletions: null },
      ],
    });
  });

  it('splits consecutive commits and handles root commits and merges', () => {
    const commits = parse([header(sha('1'), '', 'root'), '', '1\t0\ta', header(sha('2'), `${sha('3')} ${sha('4')}`, 'Merge pull request #7 from x/y')]);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.parents).toEqual([]);
    expect(commits[1]!.parents).toHaveLength(2);
    expect(commits[1]!.files).toEqual([]);
  });

  it('rejects malformed headers instead of guessing', () => {
    expect(() => parse([`${RS}not-a-sha${US}${US}a${US}b${US}2026-01-01T00:00:00Z${US}2026-01-01T00:00:00Z${US}s${US}`])).toThrow(/sha/);
    expect(() => parse([`${RS}${sha('a')}${US}only`])).toThrow(/Malformed/);
  });
});

describe('path helpers', () => {
  it('normalises rename notation to the new path', () => {
    expect(normaliseRenamePath('{src => lib}/b.js')).toBe('lib/b.js');
    expect(normaliseRenamePath('src/{old => new}/f.ts')).toBe('src/new/f.ts');
    expect(normaliseRenamePath('src/{ => sub}/f.ts')).toBe('src/sub/f.ts');
    expect(normaliseRenamePath('a.txt => b.txt')).toBe('b.txt');
    expect(normaliseRenamePath('plain/path.ts')).toBe('plain/path.ts');
  });

  it('unquotes git C-style quoted paths including octal UTF-8', () => {
    expect(unquotePath('"caf\\303\\251.md"')).toBe('café.md');
    expect(unquotePath('"tab\\there"')).toBe('tab\there');
    expect(unquotePath('normal.md')).toBe('normal.md');
  });

  it('parses timezone offsets', () => {
    expect(parseTzOffset('2026-01-01T00:00:00-02:30')).toBe(-150);
    expect(parseTzOffset('2026-01-01T00:00:00Z')).toBe(0);
  });

  it('recognises generated files, bots, noreply logins and PR numbers', () => {
    expect(isGeneratedPath('package-lock.json')).toBe(true);
    expect(isGeneratedPath('web/pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedPath('vendor/lib/x.go')).toBe(true);
    expect(isGeneratedPath('assets/app.min.js')).toBe(true);
    expect(isGeneratedPath('build/scripts/release.js')).toBe(false);
    expect(isGeneratedPath('src/lockfile.ts')).toBe(false);

    expect(isBotIdentity('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com')).toBe(true);
    expect(isBotIdentity('renovate', 'bot@renovateapp.com')).toBe(true);
    expect(isBotIdentity('Ann Robot', 'ann@x.io')).toBe(false);

    expect(loginFromNoreply('123+octo-cat@users.noreply.github.com')).toBe('octo-cat');
    expect(loginFromNoreply('octocat@users.noreply.github.com')).toBe('octocat');
    expect(loginFromNoreply('octocat@example.com')).toBeNull();

    expect(prNumberFromSubject('feat: x (#123)')).toBe(123);
    expect(prNumberFromSubject('Merge pull request #9 from a/b')).toBe(9);
    expect(prNumberFromSubject('fix #12 in parser')).toBeNull();
  });
});
