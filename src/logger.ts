import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/** One logger for the whole process. Secrets that could appear in requests are redacted. */
export function createLogger(config: Pick<Config, 'logLevel' | 'env'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'], censor: '[redacted]' },
    ...(config.env === 'development' && process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
