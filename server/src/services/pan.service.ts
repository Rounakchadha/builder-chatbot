import { env } from '../config/env';
import { hashCode } from '../flow-engine/eligibility';
import { maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { finfinityClient, FinfinityApiError } from './finfinityClient';
import { UserFacingError } from '../lib/userFacingError';

export interface PanIdentity {
  name: string;
  nameMasked: string;
  dob: string; // ISO date, e.g. "1990-01-12"
  gender?: string; // "Male" / "Female" / "Other" — see getpandetail_api_payloads.txt
}

export interface PanService {
  /** Identity lookup only — no credit data. See bureau.service.ts for the score pull. `token` is
   * the access token from the OTP #1 (dedupe) verify — required by the real service. */
  lookup(pan: string, token?: string): Promise<PanIdentity>;
}

const MOCK_NAMES = ['Rahul Sharma', 'Ananya Verma', 'Vikram Singh', 'Neha Kapoor', 'Arjun Patel', 'Ishita Bose'];

/** First + last letter visible, everything between masked — applied to every word (including the
 * first name), e.g. "Arjun Gupta" -> "A***n G***a". */
function maskWord(word: string): string {
  if (word.length <= 2) return `${word[0]}${'*'.repeat(Math.max(word.length - 1, 1))}`;
  return `${word[0]}${'*'.repeat(word.length - 2)}${word[word.length - 1]}`;
}

function maskName(name: string): string {
  // Confirmed live: getpandetail returns a double space where a middle name would go for anyone
  // without one (e.g. "SPARSH  GUPTA") — splitting on a single ' ' then turns that gap into an
  // empty-string "word", which maskWord had no case for: word[0] on '' is undefined, producing the
  // literal text "undefined" in the masked name shown to the customer. Splitting on whitespace
  // runs (and dropping empties) collapses that gap instead of masking it.
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(maskWord)
    .join(' ');
}

/** Deterministic mock, ported from the prototype's mockIdentityFromPan. */
class MockPanService implements PanService {
  async lookup(pan: string): Promise<PanIdentity> {
    const idx = Math.abs(hashCode(pan)) % MOCK_NAMES.length;
    const year = 1975 + (Math.abs(hashCode(pan.slice(1))) % 25);
    const month = 1 + (Math.abs(hashCode(pan.slice(2))) % 12);
    const day = 1 + (Math.abs(hashCode(pan.slice(3))) % 28);
    const dob = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
    const name = MOCK_NAMES[idx];

    const gender = Math.abs(hashCode(pan + 'gender')) % 2 === 0 ? 'Male' : 'Female';

    logger.info({ event: 'pan_lookup_mock', panMasked: maskPan(pan) }, 'mock PAN lookup');
    return { name, nameMasked: maskName(name), dob, gender };
  }
}

/** DD/MM/YYYY (the format getpandetail returns) -> YYYY-MM-DD. Every caller of PanIdentity.dob
 * (formatDob/calcAge in flows/homeLoan.ts) does `new Date(dobIso)`, which isn't reliable for a
 * plain DD/MM/YYYY string across JS engines/locales — normalize once, here. */
function ddmmyyyyToIso(dob: string): string {
  const [day, month, year] = dob.split('/');
  if (!day || !month || !year) return dob; // unexpected format — pass through rather than throw
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

interface PanDetailResponse {
  pan: string;
  name: string;
  dob: string; // DD/MM/YYYY
  gender?: string; // "Male" / "Female" / "Other"
}

/** Real PAN identity API — POST /leadflow/getpandetail. Identity only (name/DOB), same as the
 * mock — no credit data here, that's a separate bureau pull once bureau consent is captured. */
class RealPanService implements PanService {
  async lookup(pan: string, token?: string): Promise<PanIdentity> {
    let results: Array<{ response: PanDetailResponse }>;
    try {
      results = await finfinityClient.post<Array<{ response: PanDetailResponse }>>('/leadflow/getpandetail', { panNumber: pan }, { token });
    } catch (err) {
      // The real PAN registry rejecting the number outright (not found / bad format) is a normal,
      // expected outcome — not a service outage — so the customer gets a specific, actionable
      // message instead of the generic "trouble reaching one of our services" fallback.
      if (err instanceof FinfinityApiError && (err.code === '400' || /invalid pan/i.test(err.message))) {
        throw new UserFacingError("That PAN doesn't look valid — please check it and try again.");
      }
      throw err;
    }
    const detail = results[0]?.response;
    if (!detail) throw new Error('getpandetail returned no PAN details');
    return { name: detail.name, nameMasked: maskName(detail.name), dob: ddmmyyyyToIso(detail.dob), gender: detail.gender };
  }
}

// See FINFINITY_PAN_MOCK_OVERRIDE's comment in config/env.ts — temporary, test-only.
export const panService: PanService = env.FINFINITY_API_BASE_URL && !env.FINFINITY_PAN_MOCK_OVERRIDE ? new RealPanService() : new MockPanService();
