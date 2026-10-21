import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppDeps } from './context.js';
import { buildOpenApi } from './openapi.js';
import { registerErrorHandling, sendProblem } from './problem.js';
import { insightRoutes } from './routes/insights.js';
import { narrativeRoutes } from './routes/narrative.js';
import { repoRoutes } from './routes/repos.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const API_VERSION = '1.0.0';

/** Builds the HTTP app. Without a logger (tests) logging is off. */
export async function buildApp(deps: AppDeps, logger?: FastifyBaseLogger): Promise<FastifyInstance> {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    bodyLimit: 16 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerErrorHandling(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cors, { origin: deps.config.corsOrigins.length ? [...deps.config.corsOrigins] : false });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  await app.register(swagger, { mode: 'static', specification: { document: buildOpenApi(API_VERSION) as never } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    try {
      deps.db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch {
      return sendProblem(reply, req, { type: 'not-ready', title: 'Not ready', status: 503, detail: 'Database unavailable' });
    }
  });

  await app.register(async (scope) => {
    await repoRoutes(scope, deps);
    await insightRoutes(scope, deps);
    await narrativeRoutes(scope, deps);
  });

  const webRoot = resolve(deps.config.webDistDir);
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', index: 'index.html', maxAge: '1h' });
  }

  return app;
}
