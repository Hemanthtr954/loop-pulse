import { AppError } from './errors.js';

/** A half-open UTC interval [from, to) in epoch milliseconds. */
export interface Period {
  readonly from: number;
  readonly to: number;
}

export const DAY_MS = 86_400_000;
export const DEFAULT_PERIOD_DAYS = 90;
export const MAX_PERIOD_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Accepts YYYY-MM-DD (UTC midnight) or a full ISO-8601 datetime with an explicit offset. */
export function parseInstant(value: string): number | null {
  if (DATE_ONLY.test(value)) {
    const t = Date.parse(`${value}T00:00:00Z`);
    // Reject impossible dates like 2026-02-30, which Date.parse silently rolls over.
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value ? null : t;
  }
  if (DATE_TIME.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export interface PeriodInput {
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Resolves a period from user input. `to` defaults to the start of tomorrow (UTC) so "today"
 * is included; `from` defaults to DEFAULT_PERIOD_DAYS before `to`. A date-only `to` is
 * exclusive: `to=2026-10-01` ends at 2026-10-01T00:00Z.
 */
export function resolvePeriod(input: PeriodInput, now: number): Period {
  const errors: { field: string; message: string }[] = [];
  const to = input.to === undefined ? startOfUtcDay(now) + DAY_MS : parseInstant(input.to);
  if (to === null) errors.push({ field: 'to', message: 'must be YYYY-MM-DD or an ISO-8601 datetime with offset' });
  const from =
    input.from === undefined ? (to ?? now) - DEFAULT_PERIOD_DAYS * DAY_MS : parseInstant(input.from);
  if (from === null) errors.push({ field: 'from', message: 'must be YYYY-MM-DD or an ISO-8601 datetime with offset' });
  if (errors.length) throw AppError.badRequest('Invalid period', errors);

  if (from! >= to!) throw AppError.badRequest('Invalid period', [{ field: 'from', message: 'must be before `to`' }]);
  if (to! - from! > MAX_PERIOD_DAYS * DAY_MS) {
    throw AppError.badRequest('Invalid period', [{ field: 'from', message: `period may span at most ${MAX_PERIOD_DAYS} days` }]);
  }
  if (from! > now) throw AppError.badRequest('Invalid period', [{ field: 'from', message: 'must not be in the future' }]);
  return { from: from!, to: to! };
}

/** The period of equal length immediately before `p`. */
export function previousPeriod(p: Period): Period {
  const len = p.to - p.from;
  return { from: p.from - len, to: p.from };
}

export function startOfUtcDay(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

export function periodDays(p: Period): number {
  return (p.to - p.from) / DAY_MS;
}

export function periodToJson(p: Period): { from: string; to: string; days: number } {
  return { from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString(), days: Math.round(periodDays(p) * 100) / 100 };
}
