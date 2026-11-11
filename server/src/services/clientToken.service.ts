import { logger } from '../lib/logger';
import { env } from '../config/env';

/** Prod-only step (2026-10-31 notes from Bitsflow): "yeh api starting me call hogi ispe token
 * aayega... without otp hai yeh" — a client_id/client_secret call at the very start of the flow
 * that returns a token, no OTP involved. On UAT this doesn't exist at all; every access token
 * today comes from validateotpv2/validatebureau instead (see finfinityClient.ts's own doc comment).
 *
 * Wired in (2026-11-11) for exactly one case: routes/chat.ts's beginNewSession calls this when an
 * SDK launch token claims `verified: true` — CIS is vouching that this customer is already
 * identity-checked on their end, so we skip our own OTP and use this token to authorize the
 * dedupeCheck/searchcustomer call instead (same mechanism identityToken-resumed sessions already
 * use — see that file's own comment). An unverified or absent launch token is completely
 * unaffected — OTP runs exactly as it does today.
 *
 * Still unconfirmed, flagged rather than guessed at:
 *   1. The real request/response shape of POST /client-token/ was never confirmed with Bitsflow —
 *      the shape below is a best guess (client_id/client_secret in, an access token out), not a
 *      verified contract. Same discipline as RealBureauApi.fetchBureauData's own unconfirmed
 *      response shape (see that file).
 *   2. Only one client_id/client_secret pair is configured (FINFINITY_CLIENT_ID/_SECRET below) —
 *      we were given two with no confirmation of which is which; use whichever Bitsflow confirms.
 *   3. Known gap: this only works for a customer dedupeCheck FINDS. A customer it does NOT find
 *      has no other way in this flow to get a remoteCustomerId once OTP is skipped — see
 *      routes/chat.ts's own comment at the call site. */

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
