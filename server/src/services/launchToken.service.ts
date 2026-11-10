import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * Lets a partner's OWN backend (Finfinity's own app today; CIS or anyone else later — just an SDK,
 * no API call involved) hand the widget a customer's product/mobile/email up front, instead of
 * asking for them again from scratch.
 *
 * No network call to us at all is needed to produce one of these — that was the whole point of this
 * design (2026-11-02 discussion: an issue-then-redeem API added a real round-trip right at the
 * moment the customer clicks to open the chat, which is bad UX, and running a signature check alone
 * still left the raw values readable in the browser). Instead, the partner's backend locks the
 * payload with a shared secret only their backend and ours ever hold (AES-256-GCM: encryption, so
 * the browser only ever sees an opaque blob, AND authentication, so nobody without the secret can
 * forge or tamper with one) and hands the resulting string straight to the SDK's open() call. We
 * only ever look at it once — the moment the widget sends its very first message to actually start
 * the chat, which was always going to happen anyway.
 *
 * UAT-only today: mobile is a SUGGESTION, not a verified identity — OTP still runs normally against
 * whatever number was decrypted here. `verified` is accepted and carried through but deliberately
 * NOT wired to skip OTP yet; honoring it to skip verification entirely is a bigger trust decision
 * than prefill-to-save-typing and needs its own explicit sign-off before it does anything.
 */
const MAX_TOKEN_AGE_MS = 30 * 60 * 1000; // minted well before the click is fine (e.g. at login) —
// this is just a replay window, not a "redeem within seconds" deadline like the old design's TTL.

export interface LaunchPayload {
  product?: string;
  /** Home Loan/LAP only — exact match against shared/src/index.ts's LOAN_TYPES for whichever
   * `product` was also sent (e.g. 'Fresh purchase'/'Balance transfer (BT)' for Home loan). Skips
   * the loanType chat question the same way `product` skips the product question; silently ignored
   * (question asked normally) on no match, same convention as every other prefill field. */
  loanType?: string;
  mobile?: string;
  email?: string;
  /** Optional — only send this if the partner's own journey already collected it. It's shown to the
   * customer as a greeting/display value only; it's never trusted as verified identity and is always
   * overwritten the moment PAN lookup runs (see homeLoan.ts's panFetch step) — PAN is still asked
   * unconditionally regardless of whether this is present. If the partner doesn't have a name yet,
   * just omit the field entirely; our own PAN lookup finds it. */
  name?: string;
  verified?: boolean;
  iat: number; // ms epoch — set by the minting side, checked against MAX_TOKEN_AGE_MS on decrypt
}

const IV_LENGTH = 12; // AES-GCM standard nonce size
const TAG_LENGTH = 16;

/** Derives a fixed 32-byte AES-256 key from whatever plain-text secret string is configured — lets
 * EXTERNAL_SDK_SECRET be any passphrase rather than requiring partners to generate raw key bytes. */
function deriveKey(): Buffer {
  return crypto.createHash('sha256').update(env.EXTERNAL_SDK_SECRET).digest();
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

/** Reference implementation of what a partner's backend does locally — used by our own test tooling
 * (sdk-demo.html mints the exact same way, in-browser, for UAT testing only) and kept here as the
 * canonical example to hand partners, rather than duplicating this logic in a doc that can drift. */
export function mintLaunchToken(payload: Omit<LaunchPayload, 'iat'>): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const full: LaunchPayload = { ...payload, iat: Date.now() };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(full), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return base64url(Buffer.concat([iv, authTag, ciphertext]));
}

/** Null on anything wrong at all (bad secret, tampered bytes, malformed JSON, expired) — the caller
 * treats every failure case the same way: fall back to a normal blank session, never surface which
 * specific thing was wrong (that would help an attacker narrow down what to try next). */
export function verifyLaunchToken(token: string): LaunchPayload | null {
  try {
    const raw = fromBase64url(token);
    if (raw.length < IV_LENGTH + TAG_LENGTH) return null;
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8')) as LaunchPayload;
    if (typeof payload.iat !== 'number' || Date.now() - payload.iat > MAX_TOKEN_AGE_MS) return null;
    return payload;
  } catch {
    // Wrong secret, corrupted/truncated token, or valid-looking JSON that isn't actually ours —
    // decipher.final() throws on an auth-tag mismatch, which is GCM's own tamper detection firing.
    return null;
  }
}
