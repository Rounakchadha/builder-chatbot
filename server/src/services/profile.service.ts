import { redis } from '../lib/redis';
import { encryptPii, decryptPii, hmacLookup } from '../lib/crypto';

/** Lets a customer who's already partway through one product (Home Loan, say) open a DIFFERENT
 * product (Personal Loan) without re-answering what's already known — mobile+OTP, PAN, pincode, a
 * pulled bureau score — and lets them come back to Home Loan later and resume exactly where they
 * left off, instead of starting over. 10 minutes, sliding, same convention as
 * identity.service.ts's own window — this is a pure convenience cache, not a security-sensitive
 * token, so no absolute cap on top (unlike that file's IDENTITY_ABSOLUTE_TTL_MS).
 *
 * A Redis HASH, not a JSON blob — each field (including each product's own resume pointer) sets
 * atomically via HSET, so two browser tabs for the same mobile opening two different products at
 * the same moment can't clobber each other's write the way a read-modify-write blob merge could.
 * Deliberately separate from identity.service.ts's own opaque-token store (that one's client-held
 * and already has callers we don't want to disturb) — the two tokens are written together at the
 * same call sites (see homeLoan.ts) so they can't drift apart, rather than refactoring one to
 * delegate to the other. */
const PROFILE_TTL_SECONDS = 10 * 60;

export interface RememberedProfile {
  finfinityAccessToken?: string;
  finfinityRefreshToken?: string;
  remoteCustomerId?: number;
  creditScore?: number;
  bureauSource?: 'bureau' | 'experian';
  pincode?: string;
  income?: number;
  pan?: string;
  fullName?: string;
  dob?: string;
  gender?: string;
  panDuplicateChecked?: boolean;
}

export interface RememberedProductSession {
  conversationId: string;
  sessionToken: string;
}

function profileKey(mobile: string): string {
  return `profile:${hmacLookup(mobile)}`;
}

// Plain fields stored as-is (numbers/booleans round-tripped through strings); `pan` gets its own
// encrypt/decrypt wrapper since it's real, non-rotatable PII — every other place it touches
// storage (session.service.ts's ENCRYPT_KEYS, customer.service.ts's panEncrypted) already encrypts
// it at rest, and this cache shouldn't be the one exception.
const PROFILE_FIELDS = ['finfinityAccessToken', 'finfinityRefreshToken', 'remoteCustomerId', 'creditScore', 'bureauSource', 'pincode', 'income', 'pan', 'fullName', 'dob', 'gender', 'panDuplicateChecked'] as const;

/** Fire-and-forget from every call site — never let a profile-cache write block or fail a
 * customer's actual turn. Only ever called with the fields that just became known, so a partial
 * patch merges in via HSET without touching anything else already stored. */
export async function rememberProfile(mobile: string, patch: Partial<RememberedProfile>): Promise<void> {
  const key = profileKey(mobile);
  const fields: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    fields[field] = field === 'pan' ? encryptPii(String(value)) : String(value);
  }
  if (Object.keys(fields).length === 0) return;
  await redis.hset(key, fields);
  await redis.expire(key, PROFILE_TTL_SECONDS);
}

export async function recallProfile(mobile: string): Promise<RememberedProfile | null> {
  const key = profileKey(mobile);
  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) return null;
  await redis.expire(key, PROFILE_TTL_SECONDS); // sliding window — any read within it buys another full window
  return {
    finfinityAccessToken: raw.finfinityAccessToken,
    finfinityRefreshToken: raw.finfinityRefreshToken,
    remoteCustomerId: raw.remoteCustomerId ? Number(raw.remoteCustomerId) : undefined,
    creditScore: raw.creditScore ? Number(raw.creditScore) : undefined,
    bureauSource: raw.bureauSource as 'bureau' | 'experian' | undefined,
    pincode: raw.pincode,
    income: raw.income ? Number(raw.income) : undefined,
    pan: raw.pan ? decryptPii(raw.pan) : undefined,
    fullName: raw.fullName,
    dob: raw.dob,
    gender: raw.gender,
    panDuplicateChecked: raw.panDuplicateChecked === 'true',
  };
}

// Bug fixed 2026-11-13 (reported: switching products, or just taking a while between switches,
// started re-asking everything instead of resuming — even a session that had ALREADY reached its
// result). Root cause: this pointer used to share profileKey/PROFILE_TTL_SECONDS (10 min) with the
// convenience fields above — any gap over 10 minutes between touching a product silently lost
// track of which session to resume, even though the session itself was still perfectly alive
// (Postgres-backed well beyond that, see session.service.ts's own 30-day SESSION_MAX_AGE_MS). A
// customer's actual in-progress work on a product should only ever go away when THEY ask to start
// over, not from time alone — so this pointer now lives in its own key, with its own TTL matching
// that same 30-day window, completely decoupled from the 10-minute convenience-field cache above.
const PRODUCT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function productSessionsKey(mobile: string): string {
  return `productSessions:${hmacLookup(mobile)}`;
}

export async function rememberProductSession(mobile: string, product: string, conversationId: string, sessionToken: string): Promise<void> {
  const key = productSessionsKey(mobile);
  await redis.hset(key, product, JSON.stringify({ conversationId, sessionToken }));
  await redis.expire(key, PRODUCT_SESSION_TTL_SECONDS);
}

export async function recallProductSession(mobile: string, product: string): Promise<RememberedProductSession | null> {
  const raw = await redis.hget(productSessionsKey(mobile), product);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RememberedProductSession;
  } catch {
    return null; // corrupt/unexpected value — treat the same as "nothing cached" rather than throw
  }
}

/** Called only when the customer explicitly clicks "Start over" (see chat.ts's `forceNew` handling)
 * — without this, a deliberate restart would still resolve right back to the same old session the
 * very next time this product's launch token was opened, since the pointer itself was never told
 * to forget it. */
export async function forgetProductSession(mobile: string, product: string): Promise<void> {
  await redis.hdel(productSessionsKey(mobile), product);
}
