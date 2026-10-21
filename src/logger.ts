import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from './config.js';

const SECRET_HEADERS = ['authorization', '["x-api-key"]', 'cookie'];
export const REDACT_PATHS = ['req.headers', 'headers'].flatMap((prefix) =>
  SECRET_HEADERS.map((h) => `${prefix}${h.startsWith('[') ? '' : '.'}${h}`),
);

/** One logger for the whole process. Secrets that could appear in requests are redacted. */
export function createLogger(config: Pick<Config, 'logLevel' | 'env'>, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(!destination && config.env === 'development' && process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
