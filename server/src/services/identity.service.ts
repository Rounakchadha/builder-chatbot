import crypto from 'node:crypto';
import { redis } from '../lib/redis';

/** Lets a customer re-check eligibility without re-typing their mobile number and OTP every
 * time — only the fields the 'mobile'/'triggerOtpDedupe'/'otpDedupe' steps themselves need to be
 * skipped are kept here (see homeLoan.ts's guards on those three steps); everything else
 * (name/PAN/email/segment/etc.) gets re-derived fresh by dedupeCheck's own real API call, same as
 * it would on a normal conversation. 10 minutes, sliding — any reuse within the window buys
 * another full 10 minutes; past that, the customer verifies again from scratch. */
const IDENTITY_TTL_SECONDS = 10 * 60;

export interface RememberedIdentity {
  mobile: string;
  finfinityAccessToken?: string;
  finfinityRefreshToken?: string;
  remoteCustomerId?: number;
}

function identityKey(token: string) {
  return `identity:${token}`;
}

/** Called once identity is freshly verified (OTP success) — `existingToken` is passed back in so
 * re-verifying (e.g. the bureau-consent OTP) refreshes the SAME token/window rather than handing
 * the widget a new one to store every time. */
export async function rememberIdentity(identity: RememberedIdentity, existingToken?: string): Promise<string> {
  const token = existingToken ?? crypto.randomBytes(24).toString('hex');
  await redis.set(identityKey(token), JSON.stringify(identity), 'EX', IDENTITY_TTL_SECONDS);
  return token;
}

/** Null if never set, already expired, or the identity token is unrecognized — all treated the
 * same way by the caller: fall back to asking for mobile + OTP like normal. */
export async function recallIdentity(token: string): Promise<RememberedIdentity | null> {
  const raw = await redis.get(identityKey(token));
  if (!raw) return null;
  await redis.expire(identityKey(token), IDENTITY_TTL_SECONDS); // sliding window
  return JSON.parse(raw) as RememberedIdentity;
}
