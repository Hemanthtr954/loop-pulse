import type { ActivityResult, WeekBucket } from '../src/insights/activity.js';
import type { Contributor, ContributorsResult } from '../src/insights/contributors.js';
import type { KnowledgeRiskResult } from '../src/insights/knowledge-risk.js';
import type { InsightBundle } from '../src/narrative/facts.js';

/**
 * Eval cases: synthetic insight bundles with one planted story each, plus what a good brief
 * must (and must not) say about it. Bundles are built in code so they always match the real
 * insight types.
 */
export interface EvalCase {
  name: string;
  story: string;
  bundle: InsightBundle;
  expect: {
    /** At least one of these fact keys must be cited somewhere in the brief. */
    mustCite: string[];
    hypothesis: 'required' | 'forbidden' | 'optional';
    /** The cited hypothesis must include one of these fact keys (when hypothesis is required). */
    hypothesisCites?: string[];
    confidence?: { min?: number; max?: number };
    caveat?: RegExp;
  };
}

const person = (name: string, commits: number, total: number, churn = commits * 40): Contributor => ({
  id: name.toLowerCase().replace(/\W/g, '').padEnd(12, '0').slice(0, 12),
  name,
  login: name.split(' ')[0]!.toLowerCase(),
  isBot: false,
  commits,
  additions: Math.round(churn * 0.7),
  deletions: Math.round(churn * 0.3),
  churn,
  filesTouched: Math.max(1, Math.round(commits * 1.5)),
  activeDays: Math.max(1, Math.round(commits * 0.6)),
  mergedPrs: Math.round(commits * 0.8),
  coAuthored: 0,
  commitShare: commits / total,
  churnShare: 0,
  newcomer: false,
});

function weeks(perWeek: number[]): WeekBucket[] {
  const start = Date.parse('2026-07-27T00:00:00Z');
  return perWeek.map((commits, i) => ({
    weekStart: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
    commits,
    authors: Math.min(commits, 6),
    churn: commits * 40,
    mergedPrs: Math.round(commits * 0.8),
    partial: false,
  }));
}

interface Spec {
  people: [string, number][];
  botCommits?: number;
  weekly: number[];
  previous?: { commits: number; authors: number; reduced?: [string, number, number][]; newcomers?: { count: number; commits: number } };
  truckFactor: number;
  topShare: number;
  effective: number;
  hotspotSilo?: boolean;
  weekendShare?: number;
}

function bundle(spec: Spec): InsightBundle {
  const total = spec.people.reduce((s, [, c]) => s + c, 0);
  const items = spec.people.map(([n, c]) => person(n, c, total));
  const churn = items.reduce((s, c) => s + c.churn, 0);
  items.forEach((c) => (c.churnShare = c.churn / churn));
  const contributors: ContributorsResult = {
    totals: {
      commits: total,
      authors: items.length,
      additions: Math.round(churn * 0.7),
      deletions: churn - Math.round(churn * 0.7),
      churn,
      mergedPrs: Math.round(total * 0.8),
      botCommits: spec.botCommits ?? 0,
      incompleteCommits: 0,
    },
    items,
  };
  const top = items[0]!;
  const ref = { id: top.id, name: top.name, login: top.login };
  const knowledgeRisk: KnowledgeRiskResult = {
    filesTouched: 120,
    truckFactor: spec.truckFactor,
    truckFactorAuthors: items.slice(0, spec.truckFactor).map((c) => ({ id: c.id, name: c.name, login: c.login, filesKnown: 40 })),
    concentration: { topAuthor: ref, topShare: spec.topShare, hhi: 1 / spec.effective, effectiveContributors: spec.effective },
    hotspots: [
      { path: 'src/core/router.ts', churn: 900, commits: 9, authors: spec.hotspotSilo ? 1 : 4, topAuthor: ref, topAuthorShare: spec.hotspotSilo ? 1 : 0.45, silo: !!spec.hotspotSilo },
    ],
    areas: [{ area: 'src/', churn: Math.round(churn * 0.7), files: 80, authors: items.length, topAuthor: ref, topAuthorShare: spec.topShare }],
  };
  const w = weeks(spec.weekly);
  const sorted = [...spec.weekly].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const peak = w.reduce((b, x) => (x.commits > b.commits ? x : b), w[0]!);
  const prev = spec.previous;
  const activity: ActivityResult = {
    weeks: w,
    totals: { commits: total, authors: items.length, churn, mergedPrs: contributors.totals.mergedPrs, weekendCommitShare: spec.weekendShare ?? 0.08, medianWeeklyCommits: median, peakWeek: peak },
    previous: prev
      ? {
          period: { from: '2026-04-28T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
          totals: { commits: prev.commits, authors: prev.authors, churn: prev.commits * 40, mergedPrs: Math.round(prev.commits * 0.8) },
          change: {
            commits: Math.round(((total - prev.commits) / prev.commits) * 1e4) / 1e4,
            authors: Math.round(((items.length - prev.authors) / prev.authors) * 1e4) / 1e4,
            churn: Math.round(((churn - prev.commits * 40) / (prev.commits * 40)) * 1e4) / 1e4,
            mergedPrs: null,
          },
          reducedActivity: (prev.reduced ?? []).map(([name, before, now]) => ({
            id: name.toLowerCase().slice(0, 12),
            name,
            login: name.toLowerCase(),
            previousCommits: before,
            currentCommits: now,
            previousShare: Math.round((before / prev.commits) * 1e4) / 1e4,
          })),
          newcomers: { count: prev.newcomers?.count ?? 0, commits: prev.newcomers?.commits ?? 0, names: [] },
        }
      : null,
    previousUnavailableReason: prev ? null : 'the previous period starts before the synced history (2026-01-01)',
  };
  return {
    repo: 'example/service',
    period: { from: '2026-07-27T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', days: 91 },
    contributors,
    knowledgeRisk,
    activity,
    reviewers: null,
    flow: null,
  };
}

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

export const CASES: EvalCase[] = [
  {
    name: 'departure-drop',
    story: 'Commits fall 55%; the previous top author went silent.',
    bundle: bundle({
      people: [['Ana Lima', 14], ['Ben Ortiz', 12], ['Chen Wu', 10], ['Dev Rao', 9], ['Eli Shaw', 9]],
      weekly: flat(13, 4).map((v, i) => (i === 3 ? 6 : v)),
      previous: { commits: 120, authors: 6, reduced: [['Dana Ko', 50, 0]] },
      truckFactor: 3,
      topShare: 0.26,
      effective: 4.7,
    }),
    expect: {
      mustCite: ['shift.explainedDrop', 'shift.reduced.0'],
      hypothesis: 'required',
      hypothesisCites: ['shift.explainedDrop', 'shift.reduced.0'],
      confidence: { min: 0.5 },
    },
  },
  {
    name: 'healthy-balanced',
    story: 'Flat activity, broad ownership.',
    bundle: bundle({
      people: [['Ana Lima', 18], ['Ben Ortiz', 17], ['Chen Wu', 16], ['Dev Rao', 15], ['Eli Shaw', 15], ['Fay Ng', 14], ['Gus Park', 14], ['Hal Ito', 13], ['Ivy Cole', 12], ['Jo Reyes', 10]],
      weekly: [11, 12, 11, 12, 11, 12, 11, 12, 11, 12, 11, 12, 6],
      previous: { commits: 140, authors: 10 },
      truckFactor: 6,
      topShare: 0.14,
      effective: 9.2,
    }),
    expect: { mustCite: ['totals.commits', 'totals.authors'], hypothesis: 'optional', confidence: { max: 0.9 } },
  },
  {
    name: 'single-owner-silo',
    story: 'One author writes most of the code; truck factor 1.',
    bundle: bundle({
      people: [['Ana Lima', 70], ['Ben Ortiz', 8], ['Chen Wu', 6], ['Dev Rao', 5], ['Eli Shaw', 3], ['Fay Ng', 2]],
      weekly: flat(13, 7),
      previous: { commits: 90, authors: 6 },
      truckFactor: 1,
      topShare: 0.81,
      effective: 1.5,
      hotspotSilo: true,
    }),
    expect: { mustCite: ['risk.truckFactor', 'risk.topShare'], hypothesis: 'optional' },
  },
  {
    name: 'tiny-sample',
    story: 'Four commits in a quarter.',
    bundle: bundle({
      people: [['Ana Lima', 3], ['Ben Ortiz', 1]],
      weekly: [0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
      truckFactor: 1,
      topShare: 0.75,
      effective: 1.6,
    }),
    expect: { mustCite: ['totals.commits'], hypothesis: 'optional', confidence: { max: 0.45 }, caveat: /sample|small|few/i },
  },
  {
    name: 'bot-heavy',
    story: 'Automation makes 60% of all commits.',
    bundle: bundle({
      people: [['Ana Lima', 20], ['Ben Ortiz', 15], ['Chen Wu', 13], ['Dev Rao', 12]],
      botCommits: 90,
      weekly: flat(13, 5),
      previous: { commits: 58, authors: 4 },
      truckFactor: 2,
      topShare: 0.33,
      effective: 3.6,
    }),
    expect: { mustCite: ['totals.botShare'], hypothesis: 'optional' },
  },
  {
    name: 'spike-week',
    story: 'One week has six times the usual commits.',
    bundle: bundle({
      people: [['Ana Lima', 30], ['Ben Ortiz', 25], ['Chen Wu', 20], ['Dev Rao', 15]],
      weekly: [5, 5, 5, 5, 30, 5, 5, 5, 5, 5, 5, 5, 5],
      previous: { commits: 85, authors: 4 },
      truckFactor: 2,
      topShare: 0.3,
      effective: 3.7,
    }),
    expect: { mustCite: ['activity.peak'], hypothesis: 'optional' },
  },
];
