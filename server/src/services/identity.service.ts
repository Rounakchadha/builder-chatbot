import crypto from 'node:crypto';
import { redis } from '../lib/redis';

/** Lets a customer re-check eligibility without re-typing their mobile number and OTP every
 * time — only the fields the 'mobile'/'triggerOtpDedupe'/'otpDedupe' steps themselves need to be
 * skipped are kept here (see homeLoan.ts's guards on those three steps); everything else
 * (name/PAN/email/segment/etc.) gets re-derived fresh by dedupeCheck's own real API call, same as
 * it would on a normal conversation. 10 minutes, sliding — any reuse within the window buys
 * another full 10 minutes; past that, the customer verifies again from scratch. */
const IDENTITY_TTL_SECONDS = 10 * 60;

// Security-review finding, 2026-10-23: the sliding 10-minute window alone never truly expires —
// any reuse within the window buys another full 10 minutes, so a customer (or anyone holding this
// bearer token, e.g. via the widget's localStorage — see app.ts) who stays continuously active
// never gets asked to re-verify again, for as long as they keep using it. An absolute cap on top of
// the sliding window forces re-verification eventually regardless of activity.
const IDENTITY_ABSOLUTE_TTL_MS = 60 * 60 * 1000;

export interface RememberedIdentity {
  mobile: string;
  finfinityAccessToken?: string;
  finfinityRefreshToken?: string;
  remoteCustomerId?: number;
}

interface StoredIdentity {
  identity: RememberedIdentity;
  issuedAt: number;
}

function identityKey(token: string) {
  return `identity:${token}`;
}

/** Called once identity is freshly verified (OTP success) — `existingToken` is passed back in so
 * re-verifying (e.g. the bureau-consent OTP) refreshes the SAME token/window rather than handing
 * the widget a new one to store every time. `issuedAt` is preserved across those refreshes (not
 * reset) so the absolute cap below is measured from the FIRST real verification, not the latest. */
export async function rememberIdentity(identity: RememberedIdentity, existingToken?: string): Promise<string> {
  const token = existingToken ?? crypto.randomBytes(24).toString('hex');
  const previous = existingToken ? await redis.get(identityKey(existingToken)) : null;
  const issuedAt = previous ? (JSON.parse(previous) as StoredIdentity).issuedAt : Date.now();
  const stored: StoredIdentity = { identity, issuedAt };
  await redis.set(identityKey(token), JSON.stringify(stored), 'EX', IDENTITY_TTL_SECONDS);
  return token;
}

/** Null if never set, already expired (sliding OR the absolute cap), or the identity token is
 * unrecognized — all treated the same way by the caller: fall back to asking for mobile + OTP like
 * normal. */
export async function recallIdentity(token: string): Promise<RememberedIdentity | null> {
  const raw = await redis.get(identityKey(token));
  if (!raw) return null;
  const stored = JSON.parse(raw) as StoredIdentity;
  if (Date.now() - stored.issuedAt > IDENTITY_ABSOLUTE_TTL_MS) {
    await redis.del(identityKey(token));
    return null;
  }
  await redis.expire(identityKey(token), IDENTITY_TTL_SECONDS); // sliding window, within the absolute cap above
  return stored.identity;
}
