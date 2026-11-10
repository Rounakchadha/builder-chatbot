import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { env } from '../config/env';

/**
 * PII (PAN, mobile, OTP) must never reach logs in plaintext. Callers are
 * responsible for passing masked values (see lib/crypto.ts helpers) — this
 * redaction list is a defense-in-depth backstop for common field names.
 */
const REDACT = {
  paths: ['pan', 'mobile', 'otp', '*.pan', '*.mobile', '*.otp', 'req.headers.authorization'],
  censor: '[REDACTED]',
};
const LEVEL = env.NODE_ENV === 'production' ? 'info' : 'debug';

// Bug fixed 2026-11-07: logs only ever went to stdout, captured by Docker's own log driver — every
// `deploy.sh` run recreates the server container (see docker-compose.yml's own comment on the
// `logs` volume), which throws away the OLD container's stdout history entirely. A real customer's
// error from an hour before a deploy became unrecoverable the moment that deploy ran. LOG_DIR (a
// volume-backed path in prod, see docker-compose.yml) makes the file survive container recreation;
// one file per calendar day this process is running, so a long-lived process's log doesn't grow
// forever in a single file, and old days are easy to find/delete. Left unset (local dev default),
// this still also writes a local ./logs/*.log — harmless, already gitignored (*.log).
const LOG_DIR = env.LOG_DIR || path.join(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, fixed for this process's lifetime
const logFilePath = path.join(LOG_DIR, `app-${today}.log`);

export const logger = pino(
  { level: LEVEL, redact: REDACT },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: logFilePath, mkdir: true }) }]),
);
