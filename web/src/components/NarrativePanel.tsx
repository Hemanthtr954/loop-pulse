import { useId, useState } from 'react';
import type { Fact, Narrative } from '../api';
import { SNAPSHOT } from '../api';
import { pct } from '../format';

/** Evidence chip: shows the fact behind a claim on hover/focus, with a link to its source. */
function EvidenceChip({ id, fact }: { id: string; fact: Fact | undefined }) {
  const [open, setOpen] = useState(false);
  const tip = useId();
  if (!fact) return <span className="chip missing">{id}</span>;
  return (
    <span className="chip-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="chip" aria-describedby={tip} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        {id}
      </button>
      <span role="tooltip" id={tip} className={`chip-tip${open ? ' open' : ''}`}>
        <span className="chip-statement">{fact.statement}</span>
        <span className="chip-source">
          {SNAPSHOT ? (
            <code>{fact.source.path.split('?')[0]}#{fact.source.pointer}</code>
          ) : (
            <a href={fact.source.path} target="_blank" rel="noreferrer">
              <code>{fact.source.path.split('?')[0]}#{fact.source.pointer}</code>
            </a>
          )}
        </span>
      </span>
    </span>
  );
}

function Meter({ value, model, label }: { value: number; model: number; label: string }) {
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value} aria-label={label}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: pct(value) }} />
        {model > value && <div className="meter-model" style={{ left: pct(model) }} title={`Model said ${pct(model)}`} />}
      </div>
      <span className="meter-value">{pct(value)}</span>
    </div>
  );
}

export function NarrativePanel({ data }: { data: Narrative }) {
  const { narrative: n, evidence, confidence, generation: g } = data;
  const chips = (ids: string[]) => (
    <span className="chips">{ids.map((id) => <EvidenceChip key={id} id={id} fact={evidence[id]} />)}</span>
  );
  return (
    <section className="card narrative" aria-labelledby="brief-h">
      <div className="eyebrow">
        <span>Brief</span>
        <span className={`badge${g.degraded ? ' warn' : ''}`} title={g.degradedReason ?? undefined}>
          {g.provider === 'rules' ? 'Deterministic narrator' : `${g.provider} · ${g.model}`}
          {g.degraded ? ' (fallback)' : ''}
        </span>
      </div>
      <h2 id="brief-h">{n.headline}</h2>
      <p className="summary">{n.summary}</p>

      <ol className="findings">
        {n.findings.map((f, i) => (
          <li key={i}>
            <span>{f.claim}</span> {chips(f.evidence)}
          </li>
        ))}
      </ol>

      <div className="hypothesis">
        <h3>Root-cause hypothesis</h3>
        {n.hypothesis ? (
          <>
            <p>
              {n.hypothesis.statement} {chips(n.hypothesis.evidence)}
            </p>
            <Meter value={n.hypothesis.confidence} model={n.hypothesis.modelConfidence} label="Hypothesis confidence" />
          </>
        ) : (
          <p className="muted">The data does not support a causal explanation for this period.</p>
        )}
      </div>

      <details className="calibration">
        <summary>
          Overall confidence {pct(confidence.value)} <span className="muted">(ceiling {pct(confidence.ceiling)})</span>
        </summary>
        <p className="muted">{confidence.rationale}</p>
        {g.degradedReason && <p className="muted">Fallback reason: {g.degradedReason}</p>}
      </details>

      {n.caveats.length > 0 && (
        <ul className="caveats">
          {n.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}
    </section>
  );
}
