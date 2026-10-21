import type { ActivityResult } from '../insights/activity.js';
import type { ContributorsResult } from '../insights/contributors.js';
import { rankContributors } from '../insights/contributors.js';
import type { KnowledgeRiskResult } from '../insights/knowledge-risk.js';
import type { FlowResult, ReviewersResult } from '../insights/reviews.js';

/**
 * A fact is the unit of evidence: one number, one sentence that states it, and a pointer
 * back to the API response it came from. The LLM sees only facts; the guard checks every
 * number it writes against them.
 */
export interface Fact {
  id: string;
  key: string;
  statement: string;
  value: number;
  unit: 'count' | 'ratio' | 'lines' | 'hours' | 'days' | 'people';
  source: { path: string; pointer: string };
}

export interface InsightBundle {
  repo: string;
  period: { from: string; to: string; days: number };
  contributors: ContributorsResult;
  knowledgeRisk: KnowledgeRiskResult;
  activity: ActivityResult;
  reviewers: ReviewersResult | null;
  flow: FlowResult | null;
}

export const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
const day = (iso: string) => iso.slice(0, 10);
const who = (a: { name: string; login: string | null }) => (a.login ? `${a.name} (@${a.login})` : a.name);

export class FactSheet {
  readonly facts: Fact[] = [];
  private readonly byKey = new Map<string, Fact>();

  constructor(private readonly basePath: string, private readonly query: string) {}

  add(key: string, kind: string, pointer: string, value: number, unit: Fact['unit'], statement: string): Fact {
    const fact: Fact = {
      id: `F${this.facts.length + 1}`,
      key,
      statement,
      value,
      unit,
      // Pointers address the insight endpoint's JSON body ({ meta, data }).
      source: { path: `${this.basePath}/${kind}?${this.query}`, pointer: pointer.startsWith('/meta') ? pointer : `/data${pointer}` },
    };
    this.facts.push(fact);
    this.byKey.set(key, fact);
    return fact;
  }

  get(key: string): Fact | undefined {
    return this.byKey.get(key);
  }

  ids(...keys: string[]): string[] {
    return keys.map((k) => this.byKey.get(k)?.id).filter((id): id is string => !!id);
  }
}

export function buildFacts(b: InsightBundle, basePath: string, query: string): FactSheet {
  const s = new FactSheet(basePath, query);
  const t = b.contributors.totals;
  const span = `between ${day(b.period.from)} and ${day(b.period.to)}`;

  s.add('period.days', 'activity', '/meta/period/days', b.period.days, 'days', `The period covers ${b.period.days} days ${span}.`);
  s.add('totals.commits', 'contributors', '/totals/commits', t.commits, 'count', `${t.commits} non-merge commits landed on the default branch.`);
  s.add('totals.authors', 'contributors', '/totals/authors', t.authors, 'people', `${t.authors} people authored commits.`);
  s.add('totals.churn', 'contributors', '/totals/churn', t.churn, 'lines', `${t.churn} lines were added or deleted (excluding generated files).`);
  s.add('totals.mergedPrs', 'contributors', '/totals/mergedPrs', t.mergedPrs, 'count', `${t.mergedPrs} pull requests were merged (from commit subjects).`);

  const human = t.commits;
  if (t.botCommits > 0) {
    const botShare = t.botCommits / (t.botCommits + human);
    s.add('totals.botShare', 'contributors', '/totals/botCommits', botShare, 'ratio', `Bots made ${t.botCommits} commits, ${pct(botShare)} of all commits.`);
  }
  if (t.incompleteCommits > 0) {
    s.add('totals.incomplete', 'contributors', '/totals/incompleteCommits', t.incompleteCommits, 'count', `${t.incompleteCommits} commits at the history boundary have no line statistics.`);
  }

  rankContributors(b.contributors.items, 'commits', 3).forEach((c, i) => {
    s.add(`contributor.${i}.commits`, 'contributors', `/items/${i}/commits`, c.commits, 'count', `${who(c)} authored ${c.commits} commits (${pct(c.commitShare)} of commits).`);
  });

  const k = b.knowledgeRisk;
  if (k.truckFactor !== null) {
    const names = k.truckFactorAuthors.map((a) => a.name).join(', ');
    s.add('risk.truckFactor', 'knowledge-risk', '/truckFactor', k.truckFactor, 'people', `The truck factor is ${k.truckFactor}: losing ${names} would leave most of the ${k.filesTouched} changed files without anyone who recently worked on them.`);
  }
  s.add('risk.filesTouched', 'knowledge-risk', '/filesTouched', k.filesTouched, 'count', `${k.filesTouched} files were changed.`);
  if (k.concentration.topAuthor) {
    s.add('risk.topShare', 'knowledge-risk', '/concentration/topShare', k.concentration.topShare, 'ratio', `${who(k.concentration.topAuthor)} wrote ${pct(k.concentration.topShare)} of all churn.`);
  }
  if (k.concentration.effectiveContributors !== null) {
    s.add('risk.effective', 'knowledge-risk', '/concentration/effectiveContributors', k.concentration.effectiveContributors, 'people', `Churn is as concentrated as if ${k.concentration.effectiveContributors} people had shared it equally.`);
  }
  k.hotspots.slice(0, 2).forEach((h, i) => {
    const owner = h.silo ? `only ${who(h.topAuthor)} changed it` : `${h.authors} authors changed it, ${who(h.topAuthor)} wrote ${pct(h.topAuthorShare)}`;
    s.add(`risk.hotspot.${i}`, 'knowledge-risk', `/hotspots/${i}/churn`, h.churn, 'lines', `Hotspot ${h.path} had ${h.churn} lines of churn in ${h.commits} commits; ${owner}.`);
  });
  const area = k.areas[0];
  if (area) {
    s.add('risk.area.0', 'knowledge-risk', '/areas/0/topAuthorShare', area.topAuthorShare, 'ratio', `In the busiest area, ${area.area}, ${who(area.topAuthor)} wrote ${pct(area.topAuthorShare)} of ${area.churn} lines of churn across ${area.files} files.`);
  }

  const a = b.activity;
  s.add('activity.weekend', 'activity', '/totals/weekendCommitShare', a.totals.weekendCommitShare, 'ratio', `${pct(a.totals.weekendCommitShare)} of commits were authored on a weekend (author's local time).`);
  s.add('activity.median', 'activity', '/totals/medianWeeklyCommits', a.totals.medianWeeklyCommits, 'count', `A typical full week had ${a.totals.medianWeeklyCommits} commits (median).`);
  if (a.totals.peakWeek) {
    s.add('activity.peak', 'activity', '/totals/peakWeek/commits', a.totals.peakWeek.commits, 'count', `The busiest week (starting ${a.totals.peakWeek.weekStart}) had ${a.totals.peakWeek.commits} commits.`);
  }
  if (a.previous) {
    const p = a.previous;
    s.add('previous.commits', 'activity', '/previous/totals/commits', p.totals.commits, 'count', `The previous period of equal length had ${p.totals.commits} commits by ${p.totals.authors} authors.`);
    if (p.change.commits !== null) {
      s.add('change.commits', 'activity', '/previous/change/commits', p.change.commits, 'ratio', `Commits changed by ${signedPct(p.change.commits)} versus the previous period.`);
    }
    if (p.change.authors !== null) {
      s.add('change.authors', 'activity', '/previous/change/authors', p.change.authors, 'ratio', `Active authors changed by ${signedPct(p.change.authors)} versus the previous period.`);
    }
    p.reducedActivity.slice(0, 3).forEach((r, i) => {
      s.add(`shift.reduced.${i}`, 'activity', `/previous/reducedActivity/${i}/currentCommits`, r.currentCommits, 'count', `${who(r)} went from ${r.previousCommits} commits (${pct(r.previousShare)} of the previous period) to ${r.currentCommits}.`);
    });
    const drop = p.totals.commits - a.totals.commits;
    const lost = p.reducedActivity.reduce((sum, r) => sum + (r.previousCommits - r.currentCommits), 0);
    if (drop > 0 && lost > 0) {
      const explained = Math.min(1, lost / drop);
      s.add('shift.explainedDrop', 'activity', '/previous/reducedActivity', explained, 'ratio', `Their reduced activity accounts for ${lost} fewer commits, ${pct(explained)} of the ${drop}-commit drop.`);
    }
    if (p.newcomers.count > 0) {
      s.add('shift.newcomers', 'activity', '/previous/newcomers/count', p.newcomers.count, 'people', `${p.newcomers.count} first-time contributors (no earlier commit in the synced history) made ${p.newcomers.commits} commits.`);
      const rise = a.totals.commits - p.totals.commits;
      if (rise > 0) {
        const explained = Math.min(1, p.newcomers.commits / rise);
        s.add('shift.explainedRise', 'activity', '/previous/newcomers/commits', explained, 'ratio', `Commits by first-time contributors equal ${pct(explained)} of the ${rise}-commit increase.`);
      }
    }
  }

  if (b.reviewers && b.reviewers.totals.reviews > 0) {
    const r = b.reviewers;
    s.add('reviews.total', 'reviewers', '/totals/reviews', r.totals.reviews, 'count', `${r.totals.reviews} reviews were submitted by ${r.totals.reviewers} reviewers.`);
    const top = r.items[0];
    if (top) {
      s.add('reviews.topShare', 'reviewers', '/loadBalance/topShare', r.loadBalance.topShare, 'ratio', `@${top.login} submitted ${pct(r.loadBalance.topShare)} of reviews.`);
    }
  }
  if (b.flow && b.flow.merged > 0) {
    const f = b.flow;
    s.add('flow.merged', 'flow', '/merged', f.merged, 'count', `${f.merged} pull requests were merged according to GitHub.`);
    if (f.timeToMergeHours.p50 !== null) {
      s.add('flow.ttmP50', 'flow', '/timeToMergeHours/p50', f.timeToMergeHours.p50, 'hours', `Median time from opening to merge was ${f.timeToMergeHours.p50} hours (p90 ${f.timeToMergeHours.p90}).`);
    }
    const unreviewedShare = f.mergedWithoutReview / f.merged;
    s.add('flow.unreviewed', 'flow', '/mergedWithoutReview', unreviewedShare, 'ratio', `${f.mergedWithoutReview} merged pull requests, ${pct(unreviewedShare)}, had no review from someone other than the author.`);
    if (f.staleOpen.count > 0) {
      s.add('flow.stale', 'flow', '/staleOpen/count', f.staleOpen.count, 'count', `${f.staleOpen.count} open pull requests have been idle for over 14 days.`);
    }
  }
  return s;
}

function signedPct(ratio: number): string {
  return `${ratio >= 0 ? '+' : '-'}${pct(Math.abs(ratio))}`;
}
