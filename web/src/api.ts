/** Thin typed client over the Loop Pulse API (only the fields the UI renders). */

export interface Author {
  id: string;
  name: string;
  login: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  slug: string;
  defaultBranch: string | null;
  sync: { status: 'pending' | 'syncing' | 'ready' | 'error'; inProgress: boolean; error: string | null; lastSyncedAt: string | null };
  history: { availableFrom: string | null; headSha: string | null; dataVersion: number };
}

export interface Meta {
  repo: string;
  period: { from: string; to: string; days: number };
  query: string;
  definitions?: Record<string, string>;
}

export interface Contributor extends Author {
  isBot: boolean;
  commits: number;
  churn: number;
  additions: number;
  deletions: number;
  filesTouched: number;
  mergedPrs: number;
  activeDays: number;
  commitShare: number;
  churnShare: number;
  newcomer: boolean | null;
}

export interface Contributors {
  totals: { commits: number; authors: number; churn: number; mergedPrs: number; botCommits: number; incompleteCommits: number };
  items: Contributor[];
}

export interface KnowledgeRisk {
  filesTouched: number;
  truckFactor: number | null;
  truckFactorAuthors: (Author & { filesKnown: number })[];
  concentration: { topAuthor: Author | null; topShare: number; hhi: number; effectiveContributors: number | null };
  hotspots: { path: string; churn: number; commits: number; authors: number; topAuthor: Author; topAuthorShare: number; silo: boolean }[];
  areas: { area: string; churn: number; files: number; authors: number; topAuthor: Author; topAuthorShare: number }[];
}

export interface Week {
  weekStart: string;
  commits: number;
  authors: number;
  churn: number;
  partial: boolean;
}

export interface Activity {
  weeks: Week[];
  totals: { commits: number; authors: number; churn: number; mergedPrs: number; weekendCommitShare: number; medianWeeklyCommits: number };
  previous: {
    totals: { commits: number; authors: number; churn: number; mergedPrs: number };
    change: { commits: number | null; authors: number | null; churn: number | null; mergedPrs: number | null };
  } | null;
  previousUnavailableReason: string | null;
}

export interface Fact {
  key: string;
  statement: string;
  value: number;
  unit: string;
  source: { path: string; pointer: string };
}

export interface Narrative {
  narrative: {
    headline: string;
    summary: string;
    findings: { claim: string; evidence: string[] }[];
    hypothesis: { statement: string; evidence: string[]; confidence: number; modelConfidence: number } | null;
    caveats: string[];
  };
  confidence: { value: number; model: number; ceiling: number; rationale: string };
  evidence: Record<string, Fact>;
  generation: { provider: string; model: string; degraded: boolean; degradedReason: string | null; cached: boolean };
}

export interface Envelope<T> {
  meta: Meta;
  data: T;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

/** Snapshot builds carry pre-recorded responses keyed by request path. */
interface Snapshot {
  capturedAt: string;
  responses: Record<string, unknown>;
}
const embedded = import.meta.glob<{ default: Snapshot }>('../snapshot.json', { eager: true });
export const SNAPSHOT: Snapshot | null = import.meta.env.VITE_SNAPSHOT === '1' ? (Object.values(embedded)[0]?.default ?? null) : null;

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (SNAPSHOT) {
    const hit = SNAPSHOT.responses[path];
    if (hit === undefined) throw new ApiError({ type: 'snapshot', title: 'Not in snapshot', status: 404, detail: 'This view was not captured in the demo snapshot. Run the service locally to explore any range.' });
    return hit as T;
  }
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as Problem) ?? { type: 'network', title: res.statusText, status: res.status });
  return body as T;
}

export function insightPath(repo: string, kind: string, from: string, to: string, extra = ''): string {
  const base = kind === 'narrative' ? `/v1/repos/${repo}/narrative` : `/v1/repos/${repo}/insights/${kind}`;
  return `${base}?from=${from}&to=${to}${extra}`;
}
