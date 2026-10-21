import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';

/** RFC 9457 problem details. `type` is a relative URI documented in the README. */
export interface ProblemInput {
  type: string;
  title: string;
  status: number;
  detail?: string | undefined;
  [extension: string]: unknown;
}

export function sendProblem(reply: FastifyReply, req: FastifyRequest, problem: ProblemInput): FastifyReply {
  return reply
    .status(problem.status)
    .type('application/problem+json')
    .send({ ...problem, type: `/problems/${problem.type}`, instance: req.url.split('?')[0], requestId: req.id });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, req, { type: 'not-found', title: 'Not found', status: 404, detail: `No route for ${req.method} ${req.url.split('?')[0]}` }),
  );

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return sendProblem(reply, req, { type: err.type, title: err.title, status: err.status, detail: err.detail, ...err.extensions });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return sendProblem(reply, req, { type: 'rate-limited', title: 'Too many requests', status, detail: 'Rate limit exceeded; see the retry-after header.' });
    }
    if (status === 413) {
      return sendProblem(reply, req, { type: 'payload-too-large', title: 'Payload too large', status });
    }
    if (status >= 400 && status < 500) {
      // Fastify's own client errors (malformed JSON, wrong content type): safe to describe.
      return sendProblem(reply, req, { type: 'invalid-request', title: 'Invalid request', status, detail: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return sendProblem(reply, req, { type: 'internal', title: 'Internal server error', status: 500 });
  });
}
