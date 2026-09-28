import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGO = 'aes-256-gcm';
// PII_ENCRYPTION_KEY is validated as >=32 chars by env schema; derive a hard
// 32-byte key regardless of the raw secret's length/encoding.
const KEY = crypto.createHash('sha256').update(env.PII_ENCRYPTION_KEY).digest();

/** AES-256-GCM encrypt — used for PAN and name, which must be recoverable (shown to RM). */
export function encryptPii(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptPii(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** One-way HMAC — used for mobile number lookups (equality checks only, never displayed). */
export function hmacLookup(value: string): string {
  return crypto.createHmac('sha256', env.SESSION_HMAC_SECRET).update(value).digest('hex');
}

export function maskMobile(mobile: string): string {
  return mobile.length === 10 ? `${mobile.slice(0, 4)}XX${mobile.slice(6)}` : '**********';
}

export function maskPan(pan: string): string {
  return pan.length === 10 ? `${pan.slice(0, 5)}****${pan.slice(9)}` : '**********';
}

export function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}
