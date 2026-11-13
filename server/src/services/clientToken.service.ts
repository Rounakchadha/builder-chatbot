import { logger } from '../lib/logger';
import { env } from '../config/env';

/** Prod-only step (2026-10-31 notes from Bitsflow): "yeh api starting me call hogi ispe token
 * aayega... without otp hai yeh" — a client_id/client_secret call at the very start of the flow
 * that returns a token, no OTP involved. Confirmed LIVE against real prod 2026-11-12 (both the
 * endpoint and the exact two credential pairs Bitsflow gave) — UAT has no such endpoint at all
 * ("ClientModel matching query does not exist"), so this safely no-ops back to normal OTP there
 * regardless of configuration (see fetchClientToken's own `!res.ok` branch below).
 *
 * Wired in for exactly one case: routes/chat.ts's beginNewSession calls this when an SDK launch
 * token claims `verified: true` and no cached finfinityAccessToken is already available for this
 * mobile (see profile.service.ts) — CIS is vouching that this customer is already
 * identity-checked on their end, so we skip our own OTP and use this token to authorize the
 * dedupeCheck/searchcustomer call instead (same mechanism identityToken-resumed sessions already
 * use — see that file's own comment). An unverified or absent launch token is completely
 * unaffected — OTP runs exactly as it does today.
 *
 * Known gap, not yet resolved: this only works cleanly for a customer dedupeCheck FINDS. A
 * customer it does NOT find has no other way in this flow to get a remoteCustomerId once OTP is
 * skipped — see routes/chat.ts's own comment at the call site. */

interface ClientTokenResponse {
  data: Array<{ access: string; refresh?: string }>;
  error_msg: string;
  error_code: string;
}

export async function fetchClientToken(): Promise<string | null> {
  if (!env.FINFINITY_CLIENT_ID || !env.FINFINITY_CLIENT_SECRET) return null;

  try {
    const res = await fetch(`${env.FINFINITY_API_BASE_URL}${env.FINFINITY_CLIENT_TOKEN_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.FINFINITY_CLIENT_ID,
        client_secret: env.FINFINITY_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as ClientTokenResponse;
    // Confirmed live shape (2026-11-12): {"data": [{"access": "...", "refresh": "..."}], "error_msg": "", "error_code": ""}.
    const access = body.data?.[0]?.access;
    if (!res.ok || !access) {
      logger.error({ event: 'client_token_failed', httpStatus: res.status, errorMsg: body.error_msg }, 'client-token call did not return a usable access token');
      return null;
    }
    return access;
  } catch (err) {
    logger.error({ err, event: 'client_token_error' }, 'client-token call threw');
    return null;
  }
}
