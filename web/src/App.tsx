import { useEffect, useMemo, useState } from 'react';
import { ApiError, get, insightPath, SNAPSHOT, type Activity, type Contributors, type Envelope, type KnowledgeRisk, type Narrative, type Repo } from './api';
import { NarrativePanel } from './components/NarrativePanel';
import { ContributorsTable, RiskTables } from './components/Tables';
import { WeeklyChart } from './components/WeeklyChart';
import { DAY, isoDay, num, short, signedPct } from './format';

const PRESETS = [30, 90, 180] as const;

interface View {
  contributors: Envelope<Contributors>;
  risk: Envelope<KnowledgeRisk>;
  activity: Envelope<Activity>;
  narrative: Narrative;
}

function today(): number {
  const ref = SNAPSHOT ? Date.parse(SNAPSHOT.capturedAt) : Date.now();
  return Math.floor(ref / DAY) * DAY + DAY; // start of tomorrow, matching the API default
}

export function App() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [slug, setSlug] = useState<string>('');
  const [days, setDays] = useState<number | 'custom'>(90);
  const [custom, setCustom] = useState({ from: isoDay(today() - 90 * DAY), to: isoDay(today()) });
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => {
    if (days === 'custom') return custom;
    const to = today();
    return { from: isoDay(to - days * DAY), to: isoDay(to) };
  }, [days, custom]);

  useEffect(() => {
    get<{ items: Repo[] }>('/v1/repos')
      .then((r) => {
        setRepos(r.items);
        setSlug((s) => s || r.items.find((x) => x.sync.status === 'ready')?.slug || r.items[0]?.slug || '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const repo = repos?.find((r) => r.slug === slug);

  useEffect(() => {
    if (!repo) return;
    if (repo.sync.status !== 'ready' && !repo.history.headSha) {
      setView(null);
      setError(repo.sync.status === 'error' ? `Sync failed: ${repo.sync.error}` : 'First sync in progress…');
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    const p = (kind: string, extra = '') => insightPath(repo.slug, kind, range.from, range.to, extra);
    Promise.all([
      get<Envelope<Contributors>>(p('contributors', '&limit=100'), ctl.signal),
      get<Envelope<KnowledgeRisk>>(p('knowledge-risk'), ctl.signal),
      get<Envelope<Activity>>(p('activity'), ctl.signal),
      get<Narrative>(p('narrative'), ctl.signal),
    ])
      .then(([contributors, risk, activity, narrative]) => setView({ contributors, risk, activity, narrative }))
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : 'Could not load insights.');
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [repo?.slug, repo?.sync.status, range.from, range.to]);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path d="M1 9h3l2-6 3 10 2-4h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>Loop Pulse</span>
          {SNAPSHOT && <span className="badge" title={`Captured ${SNAPSHOT.capturedAt}`}>snapshot · {SNAPSHOT.capturedAt.slice(0, 10)}</span>}
        </div>
        <div className="controls">
          <label className="field">
            <span>Repository</span>
            <select value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!repos?.length}>
              {repos?.map((r) => <option key={r.slug} value={r.slug}>{r.slug}</option>)}
            </select>
          </label>
          <div className="segmented" role="group" aria-label="Period">
            {PRESETS.map((d) => (
              <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)} aria-pressed={days === d}>{d}d</button>
            ))}
            {!SNAPSHOT && <button className={days === 'custom' ? 'on' : ''} onClick={() => setDays('custom')} aria-pressed={days === 'custom'}>Custom</button>}
          </div>
          {days === 'custom' && (
            <div className="dates">
              <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              <span aria-hidden>→</span>
              <input type="date" aria-label="To (exclusive)" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          )}
        </div>
      </header>

      {repo && (
        <p className="context muted small">
          {repo.slug} · {repo.defaultBranch ?? 'default branch'} · {range.from} → {range.to} (exclusive)
          {repo.sync.lastSyncedAt && ` · synced ${new Date(repo.sync.lastSyncedAt).toLocaleString()}`}
          {loading && ' · loading…'}
        </p>
      )}
      {error && <div className="notice" role="alert">{error}</div>}

      {view && <Dashboard view={view} />}
    </div>
  );
}

function Dashboard({ view }: { view: View }) {
  const t = view.contributors.data.totals;
  const a = view.activity.data;
  const r = view.risk.data;
  const ch = a.previous?.change;
  const kpis: { label: string; value: string; delta?: number | null; hint: string }[] = [
    { label: 'Commits', value: num(t.commits), delta: ch?.commits, hint: view.contributors.meta.definitions?.commits ?? '' },
    { label: 'Active authors', value: num(t.authors), delta: ch?.authors, hint: 'People with at least one non-merge commit (bots excluded).' },
    { label: 'Churn', value: short(t.churn), delta: ch?.churn, hint: view.contributors.meta.definitions?.churn ?? '' },
    { label: 'Merged PRs', value: num(t.mergedPrs), delta: ch?.mergedPrs, hint: 'Distinct PR numbers in squash or merge commit subjects.' },
    { label: 'Truck factor', value: r.truckFactor === null ? '—' : String(r.truckFactor), hint: view.risk.meta.definitions?.truckFactor ?? '' },
    { label: 'Effective contributors', value: r.concentration.effectiveContributors?.toFixed(1) ?? '—', hint: view.risk.meta.definitions?.effectiveContributors ?? '' },
  ];
  return (
    <main className="grid">
      <NarrativePanel data={view.narrative} />
      <section className="kpis" aria-label="Key numbers">
        {kpis.map((k) => (
          <div className="kpi" key={k.label} title={k.hint}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
            {k.delta !== undefined && (
              <span className="kpi-delta muted">{k.delta === null ? 'no prior data' : `${signedPct(k.delta)} vs prior`}</span>
            )}
          </div>
        ))}
      </section>
      <section className="card wide">
        <WeeklyChart weeks={a.weeks} median={a.totals.medianWeeklyCommits} />
        {a.previousUnavailableReason && <p className="muted small">No comparison: {a.previousUnavailableReason}.</p>}
      </section>
      <RiskTables risk={r} />
      <ContributorsTable items={view.contributors.data.items} />
    </main>
  );
}
