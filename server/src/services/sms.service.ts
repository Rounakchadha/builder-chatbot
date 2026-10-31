import { env } from '../config/env';
import { hashOtp, hmacLookup, maskMobile } from '../lib/crypto';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { finfinityClient, FinfinityApiError } from './finfinityClient';
import { UserFacingError } from '../lib/userFacingError';

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;

// Anti-SMS-bombing: the per-conversation resend cooldown (see routes/chat.ts) doesn't stop someone
// starting many *new* conversations with the same victim's number to keep triggering fresh sends —
// each is a brand-new conversationId, so a per-conversation limit never sees them as related. This
// caps real sends to one specific number regardless of how many sessions/IPs request them.
const OTP_MOBILE_RATE_LIMIT = 5;
const OTP_MOBILE_RATE_WINDOW_SECONDS = 10 * 60;

function otpKey(conversationId: string) {
  return `otp:${conversationId}`;
}
function otpAttemptsKey(conversationId: string) {
  return `otp:attempts:${conversationId}`;
}
function otpMobileKey(conversationId: string) {
  return `otp:mobile:${conversationId}`;
}
function otpMobileRateKey(mobile: string) {
  return `otp:mobile-rate:${hmacLookup(mobile)}`;
}

/** Shared by both the mock and real sendOtp — this is a business-rule protection, not something
 * that should only exist once a real SMS gateway is wired up. Throws a distinct, user-facing
 * message rather than a generic error so the route doesn't need to know the reason. */
async function enforceOtpMobileRateLimit(mobile: string): Promise<void> {
  const key = otpMobileRateKey(mobile);
  // Security-review finding, 2026-10-23: incr() and expire() used to be two separate round-trips —
  // a crash (or a lost connection) between them left the key incremented but with no TTL, which
  // would then rate-limit this number forever with nothing to ever clear it. A single multi()
  // pipeline sends both in one round-trip, so either both apply or neither does. Re-setting the TTL
  // on every call (not just the first) turns this into a sliding window instead of a fixed one —
  // a harmless, slightly stricter change, and the simplest way to keep this atomic without relying
  // on Redis 7's EXPIRE NX option, which isn't guaranteed to be available in every deployment target.
  const results = (await redis.multi().incr(key).expire(key, OTP_MOBILE_RATE_WINDOW_SECONDS).exec()) as [Error | null, number][];
  const count = results[0][1];
  if (count > OTP_MOBILE_RATE_LIMIT) {
    throw new UserFacingError('Too many OTP requests for this number. Please try again in a few minutes.');
  }
}

// A duplicate-PAN/email match's "verify with that number" choice sends an OTP to a mobile number
// the person on this side of the chat does NOT own by definition — they got here by matching
// someone else's PAN/email, not by typing this number in themselves. That's a lower bar to trigger
// a real text to a stranger's phone than the normal signup path (which requires already knowing
// their number), so this gets its own, stricter cap on top of the general per-mobile limit above.
const DUPLICATE_VERIFY_RATE_LIMIT = 3;
const DUPLICATE_VERIFY_RATE_WINDOW_SECONDS = 60 * 60;

function duplicateVerifyRateKey(mobile: string) {
  return `otp:duplicate-verify-rate:${hmacLookup(mobile)}`;
}

export async function enforceDuplicateVerifyRateLimit(mobile: string): Promise<void> {
  const key = duplicateVerifyRateKey(mobile);
  // Same atomic incr+expire fix as enforceOtpMobileRateLimit above — see its comment.
  const results = (await redis.multi().incr(key).expire(key, DUPLICATE_VERIFY_RATE_WINDOW_SECONDS).exec()) as [Error | null, number][];
  const count = results[0][1];
  if (count > DUPLICATE_VERIFY_RATE_LIMIT) {
    throw new UserFacingError('Too many verification attempts for this account. Please try again later, or enter a different PAN/email.');
  }
}

export interface OtpVerifyResult {
  ok: boolean;
  /** The real backend's own integer customer id — validateotpv2 creates (or resolves) a customer
   * as a side effect of a successful verify, so this is the only place the not-found branch gets
   * one in the real journey. Undefined for the mock and for an already-known (dedupe-found) customer. */
  remoteCustomerId?: number;
  /** The access token this OTP verify itself returned — there's no separate login step; this IS
   * the credential every other authenticated call in the rest of the conversation uses (see
   * finfinityClient.ts's doc comment). Undefined for the mock. */
  accessToken?: string;
  refreshToken?: string;
}

export interface SmsService {
  sendOtp(conversationId: string, mobile: string): Promise<void>;
  /** Throws on lockout so the route can surface a distinct error. */
  verifyOtp(conversationId: string, code: string): Promise<OtpVerifyResult>;
}

class MockSmsService implements SmsService {
  async sendOtp(conversationId: string, mobile: string): Promise<void> {
    await enforceOtpMobileRateLimit(mobile);
    // Fixed dev OTP — this is the mock path only (no real SMS gateway configured), so there's no
    // real secret to protect; a fixed code just makes manual/local testing faster. Swap for a real
    // gateway (see RealSmsService below) before this ever runs against real users.
    const otp = '000000';
    await redis.set(otpKey(conversationId), hashOtp(otp), 'EX', OTP_TTL_SECONDS);
    await redis.del(otpAttemptsKey(conversationId));
    // Dev-mode: log instead of sending a real SMS. Swap for a gateway call once SMS_GATEWAY_API_KEY is set.
    // Field is named devOtpPlaintext (not "otp") so it survives the logger's blanket "otp" redaction —
    // that redaction exists specifically to stop a real OTP ever reaching logs in prod.
    logger.info({ event: 'otp_sent_mock', mobileMasked: maskMobile(mobile), devOtpPlaintext: otp }, 'mock OTP generated (dev only — never log real OTPs in prod)');
  }

  async verifyOtp(conversationId: string, code: string): Promise<OtpVerifyResult> {
    const attempts = Number((await redis.get(otpAttemptsKey(conversationId))) ?? '0');
    if (attempts >= OTP_MAX_ATTEMPTS) {
      throw new Error('otp_locked');
    }
    const stored = await redis.get(otpKey(conversationId));
    if (!stored) return { ok: false };

    const ok = stored === hashOtp(code);
    if (!ok) {
      // Same atomic incr+expire fix as enforceOtpMobileRateLimit above — see its comment.
      await redis.multi().incr(otpAttemptsKey(conversationId)).expire(otpAttemptsKey(conversationId), OTP_TTL_SECONDS).exec();
    } else {
      await redis.del(otpKey(conversationId));
      await redis.del(otpAttemptsKey(conversationId));
    }
    return { ok };
  }
}

interface GenerateOtpResponse {
  resend_eligible: boolean;
  resend_otp_timer: number;
  otp_response: number;
}

// Confirmed live against UAT (2026-09-28): validateotpv2 returns two DIFFERENT shapes depending
// on whether the customer already existed. A brand-new customer (error_code CUST_NOT_EXIST) gets
// the docs' two-element array — [{customer_id, corporate_id}, {access, refresh}]. An already-known
// customer gets a single-element array whose one object carries the full profile plus the token
// pair nested under `token`. Reading only one of these shapes leaves accessToken/refreshToken
// undefined for the other case, which then sends every authenticated call right after this
// (searchcustomer, getpandetail, etc.) out with no bearer token at all — so both are checked here.
interface ValidateOtpResponse {
  customer_id: number;
  token?: { access: string; refresh: string };
}
interface ValidateOtpTokenPair {
  access: string;
  refresh: string;
}

/** Real OTP API — POST /leadflow/generateotpv2 + /leadflow/validateotpv2. Public endpoints, no
 * bearer token. A successful validate also creates (or resolves) a customer as a side effect —
 * see OtpVerifyResult.remoteCustomerId. */
class RealSmsService implements SmsService {
  async sendOtp(conversationId: string, mobile: string): Promise<void> {
    await enforceOtpMobileRateLimit(mobile);
    // retryOnTransient: false — a retry here would risk sending a second real SMS for one customer action.
    await finfinityClient.post<GenerateOtpResponse[]>('/leadflow/generateotpv2', { recipient: mobile }, { retryOnTransient: false });
    // validateotpv2 needs the recipient again, but our verifyOtp signature only gets the code —
    // stash it here rather than threading mobile through every OTP step's onAnswer.
    await redis.set(otpMobileKey(conversationId), mobile, 'EX', OTP_TTL_SECONDS);
  }

  async verifyOtp(conversationId: string, code: string): Promise<OtpVerifyResult> {
    const mobile = await redis.get(otpMobileKey(conversationId));
    if (!mobile) throw new Error('otp_locked'); // no OTP was ever sent for this conversation/step

    try {
      // retryOnTransient: false — retrying blind risks burning a real attempt against the
      // account's own lockout counter for an answer we might genuinely already have.
      const results = await finfinityClient.post<[ValidateOtpResponse, ValidateOtpTokenPair?]>(
        '/leadflow/validateotpv2',
        { recipient: mobile, otp: code, creation_type: 'MOBILE' },
        { retryOnTransient: false },
      );
      const first = results[0];
      // Prefer the nested `token` (already-known-customer shape); fall back to the second array
      // element (brand-new-customer shape) when it's not there.
      const tokenPair = first?.token ?? results[1];
      return { ok: true, remoteCustomerId: first?.customer_id, accessToken: tokenPair?.access, refreshToken: tokenPair?.refresh };
    } catch (err) {
      if (err instanceof FinfinityApiError) {
        if (err.code === 'OTP401' || err.code === 'OTP_EXPIRED') return { ok: false };
        if (err.code === 'FOUND404') {
          // "Customer Already Exists" — searchcustomer should have caught this earlier, but the
          // OTP itself was still valid, so treat it as a successful verify with no new id to report.
          return { ok: true };
        }
      }
      throw err;
    }
  }
}

export const smsService: SmsService = env.FINFINITY_API_BASE_URL ? new RealSmsService() : new MockSmsService();
