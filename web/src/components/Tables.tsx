import { useState } from 'react';
import type { Contributor, KnowledgeRisk } from '../api';
import { num, pct } from '../format';

type SortKey = 'commits' | 'churn' | 'filesTouched' | 'mergedPrs';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'commits', label: 'Commits' },
  { key: 'churn', label: 'Churn' },
  { key: 'filesTouched', label: 'Files' },
  { key: 'mergedPrs', label: 'PRs' },
];

export function ContributorsTable({ items }: { items: Contributor[] }) {
  const [sort, setSort] = useState<SortKey>('commits');
  const rows = [...items].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name)).slice(0, 15);
  return (
    <section className="card" aria-labelledby="contrib-h">
      <h3 id="contrib-h">Top contributors</h3>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Author</th>
              {SORTS.map((s) => (
                <th key={s.key} className="n" aria-sort={sort === s.key ? 'descending' : 'none'}>
                  <button className={`sort${sort === s.key ? ' on' : ''}`} onClick={() => setSort(s.key)}>
                    {s.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  {c.login && <span className="muted"> @{c.login}</span>}
                  {c.newcomer && <span className="tag">new</span>}
                </td>
                <td className="n">{num(c.commits)}</td>
                <td className="n">{num(c.churn)}</td>
                <td className="n">{num(c.filesTouched)}</td>
                <td className="n">{num(c.mergedPrs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Ownership share as a thin inline bar plus the number; the number carries the value. */
function Share({ value }: { value: number }) {
  return (
    <span className="share">
      <span className="share-track"><span className="share-fill" style={{ width: pct(value) }} /></span>
      {pct(value)}
    </span>
  );
}

export function RiskTables({ risk }: { risk: KnowledgeRisk }) {
  return (
    <section className="card" aria-labelledby="risk-h">
      <h3 id="risk-h">Where knowledge is concentrated</h3>
      {risk.truckFactorAuthors.length > 0 && (
        <p className="muted small">
          Truck factor {risk.truckFactor}: {risk.truckFactorAuthors.map((a) => `${a.name} (${a.filesKnown} files)`).join(', ')}.
        </p>
      )}
      <h4>Areas</h4>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr><th>Directory</th><th className="n">Churn</th><th className="n">Authors</th><th>Top owner</th><th>Share</th></tr>
          </thead>
          <tbody>
            {risk.areas.slice(0, 6).map((a) => (
              <tr key={a.area}>
                <td><code>{a.area}</code></td>
                <td className="n">{num(a.churn)}</td>
                <td className="n">{a.authors}</td>
                <td>{a.topAuthor.name}</td>
                <td><Share value={a.topAuthorShare} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Hotspots</h4>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr><th>File</th><th className="n">Churn</th><th className="n">Authors</th><th>Top author</th></tr>
          </thead>
          <tbody>
            {risk.hotspots.slice(0, 8).map((h) => (
              <tr key={h.path}>
                <td className="path"><code>{h.path}</code>{h.silo && <span className="tag warn">silo</span>}</td>
                <td className="n">{num(h.churn)}</td>
                <td className="n">{h.authors}</td>
                <td>{h.topAuthor.name} <span className="muted">{pct(h.topAuthorShare)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
