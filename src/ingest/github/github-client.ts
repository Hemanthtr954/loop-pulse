/**
 * Small GitHub REST client: fixed base URL, bearer token in a header only, per-request
 * timeout, Link-header pagination as an async generator, and explicit rate-limit signalling.
 */
export interface GithubClientOptions {
  baseUrl: string;
  token: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class RateLimitedError extends Error {
  constructor(readonly resetAt: number) {
    super(`GitHub rate limit exhausted until ${new Date(resetAt).toISOString()}`);
  }
}

export class GithubHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`GitHub API ${status} for ${path}`);
  }
}

export interface Page<T> {
  items: T[];
  etag: string | null;
  notModified: boolean;
}

export class GithubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GithubClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Yields pages for `path` (which must start with "/"). Only URLs on the configured base
   * are ever followed, even if a Link header points elsewhere.
   */
  async *paginate<T>(path: string, params: Record<string, string>, etag?: string | null): AsyncGenerator<Page<T>> {
    if (!path.startsWith('/')) throw new Error('path must be absolute');
    let url: URL | null = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let first = true;
    while (url) {
      const res = await this.request(url, first ? etag : null);
      if (res.status === 304) {
        yield { items: [], etag: etag ?? null, notModified: true };
        return;
      }
      const items = (await res.json()) as T[];
      if (!Array.isArray(items)) throw new GithubHttpError(res.status, url.pathname);
      yield { items, etag: res.headers.get('etag'), notModified: false };
      url = this.nextLink(res.headers.get('link'));
      first = false;
    }
  }

  private async request(url: URL, etag: string | null | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'loop-pulse',
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (etag) headers['if-none-match'] = etag;

    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (res.status === 304 || res.ok) return res;

    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || retryAfter)) {
      const reset = retryAfter
        ? Date.now() + Number(retryAfter) * 1000
        : Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000 || Date.now() + 60_000;
      throw new RateLimitedError(reset);
    }
    throw new GithubHttpError(res.status, url.pathname);
  }

  private nextLink(link: string | null): URL | null {
    if (!link) return null;
    for (const part of link.split(',')) {
      const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (!m) continue;
      const next = new URL(m[1]!);
      const base = new URL(this.opts.baseUrl);
      return next.origin === base.origin ? next : null;
    }
    return null;
  }
}
