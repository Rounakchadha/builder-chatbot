import { logger } from '../lib/logger';
import { redis } from '../lib/redis';

const WINDOW_SECONDS = 10 * 60; // 10 minutes
// Same error, same Finfinity endpoint, this many times inside the window — a REAL per-customer
// rejection (wrong PAN, no bureau data, etc.) never repeats itself at this volume across different
// customers in a 10-minute span, so this many hits means something systemic on Finfinity's side,
// not an individual customer's problem.
const SYSTEMIC_THRESHOLD = 5;
// Once alerted, don't email again for the same endpoint+code combo for a while — the count keeps
// climbing (and keeps being treated as systemic for customer-messaging purposes) but the team
// doesn't need a fresh email every single failure once they've already been told once.
const ALERT_COOLDOWN_SECONDS = 30 * 60;

function countKey(path: string, code: string): string {
  return `alert:finfinity_err_count:${path}:${code}`;
}
function cooldownKey(path: string, code: string): string {
  return `alert:finfinity_err_sent:${path}:${code}`;
}

/**
 * Tracks how often the SAME Finfinity endpoint fails with the SAME error code. Found this gap the
 * hard way (2026-11-06): a real getpandetail 402 repeated 8 times over 15 minutes, silently blocking
 * PAN verification for at least one real customer, and only surfaced days later by chance when a log
 * analysis was requested for something else — nothing actually told anyone it was happening while it
 * was happening.
 *
 * Two things happen once this looks systemic rather than a one-off blip:
 * 1. A distinctly-tagged `systemic_api_failure` log line fires (once per cooldown window, not once
 *    per failure) — deliberately its own event name, not just another `finfinity_api_error`, so it's
 *    easy to grep the persisted log file (see lib/logger.ts) for "did something systemic happen"
 *    without wading through routine per-request noise. 2026-11-08: no email for this (yet) — the
 *    user explicitly chose log-only over an email alert; revisit if that changes.
 * 2. The caller (finfinityClient.ts) gets told so it can mark the thrown FinfinityApiError as
 *    `isSystemic` — which routes/chat.ts uses to show a different, more honest customer message
 *    (see SYSTEMIC_SERVICE_ERROR_TEXT there) instead of the default "try again in a moment", which
 *    was actively encouraging customers to keep blindly retrying something that wasn't transient.
 *
 * Fire-and-forget in spirit — a tracking failure (e.g. Redis briefly down) is logged and swallowed,
 * never blocks or fails the real request this is piggybacking on.
 */
export async function reportFinfinityApiFailure(path: string, code: string, message: string): Promise<{ isSystemic: boolean }> {
  try {
    const key = countKey(path, code);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    const isSystemic = count >= SYSTEMIC_THRESHOLD;

    if (isSystemic) {
      const alreadyAlerted = await redis.get(cooldownKey(path, code));
      if (!alreadyAlerted) {
        await redis.set(cooldownKey(path, code), '1', 'EX', ALERT_COOLDOWN_SECONDS);
        logger.error(
          { event: 'systemic_api_failure', path, code, count, windowMinutes: WINDOW_SECONDS / 60, message },
          `SYSTEMIC ALERT: ${path} has returned error code "${code}" ${count} times in the last ${WINDOW_SECONDS / 60} minutes — this looks like an ongoing issue, not a one-off. Customers are now being shown a "known issue" message instead of "try again".`,
        );
      }
    }

    return { isSystemic };
  } catch (err) {
    logger.error({ err, event: 'alerting_tracking_failed', path, code }, 'failed to track Finfinity API failure for alerting — continuing without it');
    return { isSystemic: false };
  }
}
