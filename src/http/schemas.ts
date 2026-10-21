import { z } from 'zod';
import { CONTRIBUTOR_SORTS } from '../insights/contributors.js';

const dateish = z
  .string()
  .max(40)
  .describe('YYYY-MM-DD (UTC midnight) or ISO-8601 datetime with offset');

const boolString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const limit = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

export const PeriodQuery = z.strictObject({
  from: dateish.optional().describe('Inclusive start. Default: 90 days before `to`.'),
  to: dateish.optional().describe('Exclusive end. Default: start of tomorrow (UTC).'),
});

const withBots = { includeBots: boolString.describe('Include bot accounts (dependabot, renovate, …)') };

export const ContributorsQuery = PeriodQuery.extend({
  ...withBots,
  sort: z.enum(CONTRIBUTOR_SORTS).default('commits'),
  limit: limit(10, 100),
});
export const KnowledgeRiskQuery = PeriodQuery.extend({ ...withBots, limit: limit(10, 50).describe('Hotspots and areas to return') });
export const ActivityQuery = PeriodQuery.extend(withBots);
export const ReviewersQuery = PeriodQuery.extend({ ...withBots, limit: limit(10, 100) });
export const FlowQuery = PeriodQuery.extend(withBots);
export const NarrativeQuery = PeriodQuery;

export const RegisterRepoBody = z.strictObject({
  owner: z.string().min(1).max(39),
  name: z.string().min(1).max(100),
});
