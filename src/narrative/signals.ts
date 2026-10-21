import type { FactSheet, InsightBundle } from './facts.js';

/**
 * Deterministic detectors. They decide what is notable (so the model does not have to guess)
 * and how strongly the data supports it (which caps the reported confidence).
 */
export interface Signal {
  kind: string;
  title: string;
  strength: number;
  /** true if this signal can support a root-cause hypothesis, not just an observation */
  causal: boolean;
  evidence: string[];
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function detectSignals(b: InsightBundle, facts: FactSheet): Signal[] {
  const out: Signal[] = [];
  const t = b.contributors.totals;
  const k = b.knowledgeRisk;
  const a = b.activity;
  const add = (s: Omit<Signal, 'evidence'> & { keys: string[] }) => {
    const evidence = facts.ids(...s.keys);
    if (evidence.length) out.push({ kind: s.kind, title: s.title, strength: Math.round(clamp(s.strength) * 100) / 100, causal: s.causal, evidence });
  };

  if (k.truckFactor !== null && k.truckFactor <= 2 && t.authors >= 4) {
    add({ kind: 'low-truck-factor', title: 'Knowledge of the active code rests on very few people', strength: k.truckFactor === 1 ? 0.9 : 0.65, causal: false, keys: ['risk.truckFactor', 'totals.authors'] });
  }
  if (k.concentration.topShare >= 0.4 && t.authors >= 3) {
    add({ kind: 'churn-concentration', title: 'One author dominates the changes', strength: (k.concentration.topShare - 0.3) / 0.5, causal: false, keys: ['risk.topShare', 'risk.effective'] });
  }
  const hot = k.hotspots[0];
  if (hot?.silo && hot.commits >= 3) {
    add({ kind: 'silo-hotspot', title: 'The most-changed file has a single author', strength: 0.5, causal: false, keys: ['risk.hotspot.0'] });
  }

  const p = a.previous;
  if (p && p.change.commits !== null && Math.abs(p.change.commits) >= 0.3 && p.totals.commits >= 10) {
    const down = p.change.commits < 0;
    add({ kind: down ? 'activity-drop' : 'activity-rise', title: down ? 'Activity fell sharply versus the previous period' : 'Activity rose sharply versus the previous period', strength: Math.abs(p.change.commits) / 0.8, causal: false, keys: ['change.commits', 'previous.commits', 'totals.commits'] });

    const explained = facts.get('shift.explainedDrop');
    if (down && p.reducedActivity.length && explained) {
      add({ kind: 'contributor-departure', title: 'Previously central contributors went quiet', strength: explained.value, causal: true, keys: ['shift.explainedDrop', ...p.reducedActivity.slice(0, 3).map((_, i) => `shift.reduced.${i}`), 'change.commits'] });
    }
    const rise = facts.get('shift.explainedRise');
    if (!down && p.newcomers.count >= 2 && rise && rise.value >= 0.3) {
      add({ kind: 'newcomer-surge', title: 'New contributors drove the increase', strength: rise.value, causal: true, keys: ['shift.explainedRise', 'shift.newcomers', 'change.commits'] });
    }
  }
  if (p && p.newcomers.count >= 3 && !out.some((s) => s.kind === 'newcomer-surge')) {
    add({ kind: 'newcomers', title: 'Several first-time contributors arrived', strength: 0.35, causal: false, keys: ['shift.newcomers'] });
  }

  const peak = a.totals.peakWeek;
  if (peak && a.totals.medianWeeklyCommits >= 1 && peak.commits >= 3 * a.totals.medianWeeklyCommits && peak.commits >= 8) {
    add({ kind: 'spike-week', title: 'One week stands out', strength: clamp(peak.commits / a.totals.medianWeeklyCommits / 6), causal: false, keys: ['activity.peak', 'activity.median'] });
  }
  if (a.totals.weekendCommitShare >= 0.25 && t.commits >= 20) {
    add({ kind: 'weekend-work', title: 'A large share of work happens on weekends', strength: 0.3, causal: false, keys: ['activity.weekend'] });
  }
  const bot = facts.get('totals.botShare');
  if (bot && bot.value >= 0.3) {
    add({ kind: 'bot-heavy', title: 'Automation produces a large share of commits', strength: 0.4, causal: false, keys: ['totals.botShare'] });
  }

  if (b.reviewers && b.reviewers.totals.reviewers >= 3 && b.reviewers.loadBalance.topShare >= 0.5) {
    add({ kind: 'review-concentration', title: 'Review load sits on one person', strength: (b.reviewers.loadBalance.topShare - 0.3) / 0.5, causal: false, keys: ['reviews.topShare', 'reviews.total'] });
  }
  const unreviewed = facts.get('flow.unreviewed');
  if (unreviewed && unreviewed.value >= 0.2 && (b.flow?.merged ?? 0) >= 10) {
    add({ kind: 'unreviewed-merges', title: 'Many changes merge without review', strength: unreviewed.value, causal: false, keys: ['flow.unreviewed', 'flow.merged'] });
  }

  return out.sort((x, y) => y.strength - x.strength || x.kind.localeCompare(y.kind));
}

/** How much the period's data can support any conclusion: 0 (none) … 1 (plenty). */
export function dataSufficiency(b: InsightBundle): number {
  const activeWeeks = b.activity.weeks.filter((w) => w.commits > 0).length;
  return clamp(
    0.4 * Math.min(1, b.contributors.totals.commits / 100) +
      0.3 * Math.min(1, activeWeeks / 8) +
      0.3 * Math.min(1, b.contributors.totals.authors / 5),
  );
}
