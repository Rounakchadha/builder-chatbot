import { env } from '../config/env';
import { decryptPii, encryptPii, hmacLookup, maskMobile, maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { finfinityClient, FinfinityApiError } from './finfinityClient';

export interface DedupeMatch {
  /** Our OWN local database row id (see prisma.customer) — only set by the mock, which persists a
   * local Customer row. The real service has no local row to point to (a real customer's data
   * lives in Finfinity's own system, referenced by remoteCustomerId instead) — never set this to
   * the remote backend's id, or callers that pass it to `prisma.conversation.update({customerId})`
   * will crash on a foreign-key violation, since no local row with that id exists. */
  customerId?: string;
  /** The real backend's own integer customer id — needed by create_anacity_lead/getcustomeroffers
   * later. Absent for a match that only exists in our own local mock Customer table. */
  remoteCustomerId?: number;
  name?: string;
  pan?: string; // decrypted, masked before ever reaching the client
  dob?: string;
  email?: string;
  pincode?: string;
  segment?: string;
  creditScore?: number;
}

/** What updateCustomer needs to sync onto the real customer record — everything the real
 * updatecustomerv3 API accepts. Any field omitted is simply not sent (not cleared). */
export interface CustomerUpdate {
  pan?: string;
  email?: string;
  pincode?: string;
  segment?: string; // our display string, e.g. "Salaried" — mapped to their applicant_type below
}

/** An existing customer record found by PAN/email instead of by mobile — used to stop a
 * not-found-branch customer from having their PAN/email written onto a brand-new record when
 * that PAN/email already belongs to somebody else's account (which would otherwise silently
 * overwrite/corrupt that other customer's data the moment updateCustomer ran). `mobileFull` is
 * only ever used internally, to send a fresh OTP to the account this PAN/email actually belongs
 * to — the customer is only ever shown `mobileMasked`. */
export interface DuplicateMatch {
  remoteCustomerId?: number;
  mobileFull: string;
  mobileMasked: string;
  name?: string;
  pan?: string;
  dob?: string;
  email?: string;
  pincode?: string;
  segment?: string;
  creditScore?: number;
}

export interface DedupeService {
  /** Is this mobile number already a known customer? Takes the raw mobile — the real
   * searchcustomer API needs the plaintext number, not a lookup hash. `token` is the access token
   * from the OTP #1 (dedupe) verify — required by the real service, unused by the mock. */
  check(mobile: string, token?: string): Promise<DedupeMatch | null>;
  /** Syncs PAN/email/pincode/employment type onto the customer record. `remoteCustomerId` is the
   * real backend's own integer id (undefined on the mock, which just logs). */
  updateCustomer(remoteCustomerId: number | undefined, update: CustomerUpdate, token?: string): Promise<void>;
  /** Looks for an existing customer already carrying this exact PAN/email — called right after
   * each is entered on the not-found branch, before either is ever written onto the new record. */
  matchBy(field: 'pan' | 'email', value: string, token?: string): Promise<DuplicateMatch | null>;
}

/** The one designated demo account for the "found" branch — every other mobile number is treated
 * as a new customer, no matter what Customer rows earlier test sessions happened to leave behind. */
const DEMO_MOBILE = '9415011227';
const DEMO_MOBILE_HASH = hmacLookup(DEMO_MOBILE);
const DEMO_PROFILE = {
  pan: 'ABCDE1234F',
  name: 'Ananya Verma',
  dob: '1983-05-14',
  email: 'ananya.verma@example.com',
  pincode: '400051',
  segment: 'Salaried',
  creditScore: 812,
};

function toMatch(customer: {
  id: string;
  nameEncrypted: string | null;
  panEncrypted: string | null;
  dob: string | null;
  email: string | null;
  pincode: string | null;
  segment: string | null;
  creditScore: number | null;
}): DedupeMatch {
  return {
    customerId: customer.id,
    name: customer.nameEncrypted ? decryptPii(customer.nameEncrypted) : undefined,
    pan: customer.panEncrypted ? decryptPii(customer.panEncrypted) : undefined,
    dob: customer.dob ?? undefined,
    email: customer.email ?? undefined,
    pincode: customer.pincode ?? undefined,
    segment: customer.segment ?? undefined,
    creditScore: customer.creditScore ?? undefined,
  };
}

/** Mock — the demo account is pre-seeded (idempotently) so it's always available as a guaranteed
 * "found" walkthrough. Every other mobile number is looked up against whatever this mock has
 * actually persisted before: a number with no Customer row yet is a genuine new customer, but a
 * number that already went through the not-found signup flow once is correctly found on the next
 * check — instead of walking through PAN/OTP again and crashing on a duplicate mobileHash when
 * createCustomer tries to insert a second row for the same number. */
class MockDedupeService implements DedupeService {
  async check(mobile: string): Promise<DedupeMatch | null> {
    const mobileHash = hmacLookup(mobile);

    if (mobileHash === DEMO_MOBILE_HASH) {
      const customer = await prisma.customer.upsert({
        where: { mobileHash },
        create: {
          mobileHash,
          mobileMasked: maskMobile(DEMO_MOBILE),
          panEncrypted: encryptPii(DEMO_PROFILE.pan),
          panMasked: maskPan(DEMO_PROFILE.pan),
          nameEncrypted: encryptPii(DEMO_PROFILE.name),
          dob: DEMO_PROFILE.dob,
          email: DEMO_PROFILE.email,
          pincode: DEMO_PROFILE.pincode,
          segment: DEMO_PROFILE.segment,
          creditScore: DEMO_PROFILE.creditScore,
          bureauSource: 'bureau',
        },
        update: {},
      });
      logger.info({ event: 'dedupe_check_mock', customerId: customer.id }, 'mock dedupe match found (demo account)');
      return toMatch(customer);
    }

    const customer = await prisma.customer.findUnique({ where: { mobileHash } });
    if (!customer) return null;

    logger.info({ event: 'dedupe_check_mock', customerId: customer.id }, 'mock dedupe match found (previously signed up)');
    return toMatch(customer);
  }

  async updateCustomer(): Promise<void> {
    logger.info({ event: 'dedupe_update_customer_mock' }, 'mock customer update (no-op — nothing real to sync)');
  }

  // Mock mode has no cross-customer collision to catch — it never writes a PAN/email onto some
  // OTHER local Customer row (updateMissingField only ever targets the current conversation's own
  // customerId), so there's nothing here for the real backend's duplicate-account problem to mirror.
  async matchBy(): Promise<DuplicateMatch | null> {
    return null;
  }
}

/** "Salaried" -> "salaried", the reverse of mapRemoteSegment. Falls back to undefined (field
 * simply omitted from the request) for anything unrecognized rather than guessing. */
function mapSegmentToApplicantType(segment: string | undefined): string | undefined {
  if (segment === 'Salaried') return 'salaried';
  if (segment === 'Self-employed professional') return 'self_employed_professional';
  if (segment === 'Business owner') return 'self_employed_business';
  return undefined;
}

/** e.g. "salaried" -> "Salaried". Falls back to undefined (rather than guessing) for any segment
 * value the real backend sends that we don't recognize yet — the segment question is still asked
 * in that case instead of silently mis-mapping someone's employment type. */
export function mapRemoteSegment(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'salaried') return 'Salaried';
  if (v === 'self_employed' || v === 'self_employed_professional' || v === 'self-employed' || v === 'professional') return 'Self-employed professional';
  if (v === 'business_owner' || v === 'self_employed_business' || v === 'business') return 'Business owner';
  return undefined;
}

interface SearchCustomerResult {
  id: number;
  customer_name?: string;
  first_name?: string;
  dob?: string;
  primary_email?: string;
  official_email?: string;
  primary_phone_number?: string;
  pan_number?: string;
  service_pincode?: string;
  customer_segment?: string;
}

/** Real Dedupe API — POST /leadflow/searchcustomer. Checked by mobile, since that's the one field
 * we always have at this point in the conversation (PAN/email aren't collected yet for a new
 * customer). No credit score in this response — that's fine, our own bureauFetchFound step already
 * fetches one separately if it's still missing once we get there.
 *
 * Confirmed live against UAT: validateotpv2 (OTP #1, which always runs right before this) creates
 * a bare customer record — mobile only, no PAN/name — as a side effect for a genuinely brand-new
 * person. searchcustomer then "finds" that bare shell, which would otherwise route a real
 * first-time customer into the found branch (skipping PAN collection entirely, since that only
 * happens on the not-found path) despite having no actual profile to show. Treat a match with no
 * PAN on file as not-found — PAN is the one field this flow can't do without either way. */
class RealDedupeService implements DedupeService {
  async check(mobile: string, token?: string): Promise<DedupeMatch | null> {
    try {
      const results = await finfinityClient.post<SearchCustomerResult[]>('/leadflow/searchcustomer', { phone_number: mobile }, { token });
      const match = results[0];
      if (!match || !match.pan_number) return null;

      return {
        remoteCustomerId: match.id,
        name: match.customer_name || match.first_name,
        pan: match.pan_number,
        dob: match.dob,
        email: match.official_email || match.primary_email,
        pincode: match.service_pincode,
        segment: mapRemoteSegment(match.customer_segment),
      };
    } catch (err) {
      if (err instanceof FinfinityApiError && err.code === 'CUSTOMER_NOT_FOUND') return null;
      throw err;
    }
  }

  /** Real API — POST /leadflow/updatecustomerv3. Only sends the fields actually present in
   * `update`, so a partial sync (e.g. just PAN) never wipes out fields on the record it doesn't
   * know about. */
  async updateCustomer(remoteCustomerId: number | undefined, update: CustomerUpdate, token?: string): Promise<void> {
    if (remoteCustomerId === undefined) {
      throw new Error('updateCustomer: no remoteCustomerId on this conversation — nothing to sync against on the real backend');
    }
    const update_fields: Record<string, string> = {};
    if (update.pan) update_fields.pan = update.pan;
    if (update.email) {
      update_fields.primary_email = update.email;
      update_fields.official_email = update.email;
    }
    if (update.pincode) update_fields.service_pincode = update.pincode;
    const applicantType = mapSegmentToApplicantType(update.segment);
    if (applicantType) update_fields.applicant_type = applicantType;

    if (Object.keys(update_fields).length === 0) return; // nothing to sync

    await finfinityClient.post('/leadflow/updatecustomerv3', { customer_id: remoteCustomerId, update_fields }, { token });
  }

  /** Confirmed live against UAT (2026-09-28): searchcustomer also accepts `pan` and `email` as
   * alternate lookup keys (not just `phone_number`) and returns the matching customer, including
   * their full phone number — which lets a "verify with that number instead" flow send a real OTP
   * to it without ever asking the customer to type someone else's number in. */
  async matchBy(field: 'pan' | 'email', value: string, token?: string): Promise<DuplicateMatch | null> {
    try {
      const body = field === 'pan' ? { pan: value } : { email: value };
      const results = await finfinityClient.post<SearchCustomerResult[]>('/leadflow/searchcustomer', body, { token });
      const match = results[0];
      if (!match || !match.primary_phone_number) return null;

      return {
        remoteCustomerId: match.id,
        mobileFull: match.primary_phone_number,
        mobileMasked: maskMobile(match.primary_phone_number),
        name: match.customer_name || match.first_name,
        pan: match.pan_number,
        dob: match.dob,
        email: match.official_email || match.primary_email,
        pincode: match.service_pincode,
        segment: mapRemoteSegment(match.customer_segment),
      };
    } catch (err) {
      if (err instanceof FinfinityApiError && err.code === 'CUSTOMER_NOT_FOUND') return null;
      throw err;
    }
  }
}

export const dedupeService: DedupeService = env.FINFINITY_API_BASE_URL ? new RealDedupeService() : new MockDedupeService();
