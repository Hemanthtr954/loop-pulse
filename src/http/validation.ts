import type { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { makeRepoRef, type RepoRef } from '../domain/repo-ref.js';

/** Parses untrusted input with a Zod schema; failures become a 400 with per-field errors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw AppError.badRequest(
    `Invalid ${what}`,
    result.error.issues.map((i) => ({
      field: i.path.join('.') || (i.code === 'unrecognized_keys' ? (i as { keys?: string[] }).keys?.join(', ') ?? what : what),
      message: i.message,
    })),
  );
}

export function repoFromParams(params: unknown): RepoRef {
  const { owner, name } = (params ?? {}) as { owner?: string; name?: string };
  const ref = owner && name ? makeRepoRef(owner, name) : null;
  if (!ref) throw AppError.badRequest('Invalid repository', [{ field: 'owner/name', message: 'must be a valid GitHub owner and repository name' }]);
  return ref;
}
