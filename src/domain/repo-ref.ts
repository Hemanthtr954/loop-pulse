/**
 * A GitHub repository reference. Validation follows GitHub's own naming rules, and is the
 * SSRF boundary: only refs that pass here are ever turned into a URL, and the URL host is fixed.
 */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

// Owners: alphanumerics and single hyphens, no leading/trailing hyphen, max 39 chars.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Repo names: alphanumerics, '-', '_', '.', max 100 chars; '.' and '..' are reserved.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepoName(name: string): boolean {
  return NAME_RE.test(name) && name !== '.' && name !== '..' && !name.toLowerCase().endsWith('.git');
}

export function makeRepoRef(owner: string, name: string): RepoRef | null {
  if (!isValidOwner(owner) || !isValidRepoName(name)) return null;
  return { owner, name };
}

/** Parses "owner/name". Returns null for anything else (URLs, paths, extra segments). */
export function parseRepoRef(input: string): RepoRef | null {
  const parts = input.split('/');
  if (parts.length !== 2) return null;
  return makeRepoRef(parts[0]!, parts[1]!);
}

export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** GitHub treats owner/name case-insensitively; so do we for identity and allowlists. */
export function repoKey(ref: RepoRef): string {
  return repoSlug(ref).toLowerCase();
}
