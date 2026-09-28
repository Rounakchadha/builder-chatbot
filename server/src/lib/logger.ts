import pino from 'pino';
import { env } from '../config/env';

/**
 * PII (PAN, mobile, OTP) must never reach logs in plaintext. Callers are
 * responsible for passing masked values (see lib/crypto.ts helpers) — this
 * redaction list is a defense-in-depth backstop for common field names.
 */
export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['pan', 'mobile', 'otp', '*.pan', '*.mobile', '*.otp', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});
