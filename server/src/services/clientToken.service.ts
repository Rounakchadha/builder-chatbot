import { logger } from '../lib/logger';
import { env } from '../config/env';

/** Prod-only step (2026-10-31 notes from Bitsflow): "yeh api starting me call hogi ispe token
 * aayega... without otp hai yeh" — a client_id/client_secret call at the very start of the flow
 * that returns a token, no OTP involved. On UAT this doesn't exist at all; every access token
 * today comes from validateotpv2/validatebureau instead (see finfinityClient.ts's own doc comment).
 *
 * NOT YET WIRED INTO ANY FLOW. Two open questions block that:
 *   1. Whether this token REPLACES the OTP-derived token everywhere, or is used ALONGSIDE the
 *      customer's own mobile OTP step for a different purpose (e.g. app-level auth vs.
 *      customer-level auth) — the two client_id/client_secret pairs we were given were never
 *      confirmed as to which is which, or whether both are even meant to be used (see
 *      FINFINITY_CLIENT_ID/FINFINITY_CLIENT_SECRET in config/env.ts).
 *   2. The real request/response shape of POST /client-token/ was never confirmed with Bitsflow —
 *      the shape below is a best guess (client_id/client_secret in, an access token out), not a
 *      verified contract. Same discipline as RealBureauApi.fetchBureauData's own unconfirmed
 *      response shape (see that file) — don't let this quietly become load-bearing on a guess.
 *
 * Confirm both with Bitsflow against a real prod call before wiring this into any flow's auth. */

interface ClientTokenResponse {
  access_token: string;
  refresh_token?: string;
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
    if (!res.ok) {
      logger.error({ event: 'client_token_http_error', httpStatus: res.status }, 'client-token call returned a non-2xx status');
      return null;
    }
    const body = (await res.json()) as ClientTokenResponse;
    if (!body.access_token) {
      logger.error({ event: 'client_token_unexpected_shape' }, 'client-token response had no access_token — confirmed-shape assumption may be wrong');
      return null;
    }
    return body.access_token;
  } catch (err) {
    logger.error({ err, event: 'client_token_failed' }, 'client-token call failed');
    return null;
  }
}
