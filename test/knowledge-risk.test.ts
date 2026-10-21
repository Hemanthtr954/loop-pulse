import { describe, expect, it } from 'vitest';
import { truckFactor } from '../src/insights/knowledge-risk.js';
import { hhi, percentile } from '../src/insights/query.js';

const files = (spec: Record<string, number[]>) => new Map(Object.entries(spec).map(([k, v]) => [k, new Set(v)]));

describe('truckFactor (greedy)', () => {
  it('is 1 when one author knows most files', () => {
    const r = truckFactor(files({ a: [1], b: [1], c: [1], d: [2] }));
    expect(r.value).toBe(1);
    expect(r.removed).toEqual([{ authorId: 1, files: 3 }]);
  });

  it('counts shared knowledge: a file is orphaned only when all its knowers are gone', () => {
    // Every file known by two people → removing one never orphans anything on its own.
    const r = truckFactor(files({ a: [1, 2], b: [1, 2], c: [3, 4], d: [3, 4] }));
    expect(r.value).toBe(4);
  });

  it('stops as soon as more than half the files are orphaned', () => {
    const r = truckFactor(files({ a: [1], b: [2], c: [3], d: [4], e: [5] }));
    // 1/5, 2/5 ≤ 50 %, 3/5 > 50 % → three removals.
    expect(r.value).toBe(3);
  });

  it('is null with no files', () => {
    expect(truckFactor(new Map()).value).toBeNull();
  });

  it('breaks ties deterministically by author id', () => {
    const r = truckFactor(files({ a: [2], b: [1], c: [3] }));
    expect(r.removed[0]!.authorId).toBe(1);
  });
});

describe('statistics helpers', () => {
  it('hhi is 1 for a monopoly and 1/n for n equal shares', () => {
    expect(hhi([1])).toBe(1);
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25);
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(percentile([], 50)).toBeNull();
  });
});
