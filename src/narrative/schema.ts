import { z } from 'zod';

const factId = z.string().regex(/^F\d{1,3}$/, 'evidence ids look like "F3"');

export const NarrativeDraftSchema = z.object({
  headline: z.string().min(3).max(140),
  summary: z.string().min(10).max(900),
  findings: z
    .array(z.object({ claim: z.string().min(3).max(400), evidence: z.array(factId).min(1).max(6) }))
    .min(1)
    .max(5),
  hypothesis: z
    .object({
      statement: z.string().min(3).max(400),
      evidence: z.array(factId).min(1).max(6),
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  confidence: z.number().min(0).max(1),
  caveats: z.array(z.string().min(3).max(300)).max(4),
});

export type NarrativeDraft = z.infer<typeof NarrativeDraftSchema>;

/** JSON Schema handed to providers that support structured output. */
const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(NarrativeDraftSchema, { target: 'draft-7' });
export const NARRATIVE_JSON_SCHEMA: Record<string, unknown> = jsonSchema;
