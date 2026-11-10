import { env } from '../config/env';
import { isSandboxPan } from '../config/sandbox';
import { hashCode } from '../flow-engine/eligibility';
import { maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { finfinityClient } from './finfinityClient';

/** Extra identity fields the real CIBIL/Experian pull needs alongside PAN — not used by the mock,
 * which only needs the PAN to generate a deterministic score. `customerId`/`token`, when present,
 * let pull() try the cheap fetchbureaudata lookup first (see fetchBureauData's own doc comment)
 * before falling back to the "not implemented" error. */
export interface BureauPullContext {
  dob?: string;
  pincode?: string;
  email?: string;
  customerId?: number;
  token?: string;
  productCode?: string;
}

export interface BureauService {
  /** Pulls a fresh credit score for the given PAN. Falls back to Experian if the primary
   * bureau pull fails, and only throws once both have been tried. */
  pull(pan: string, context?: BureauPullContext): Promise<BureauPull>;
}

function mockScore(pan: string, salt: string): number {
  return 680 + (Math.abs(hashCode(pan + salt)) % 171); // 680-850
}

/** Deterministic mock — primary "bureau" pull always succeeds, so the Experian fallback path
 * only exercises in RealBureauService once real credentials are wired up. */
class MockBureauService implements BureauService {
  async pull(pan: string): Promise<BureauPull> {
    logger.info({ event: 'bureau_pull_mock', panMasked: maskPan(pan) }, 'mock bureau pull');
    return { creditScore: mockScore(pan, 'bureau'), source: 'bureau' };
  }
}

interface GenerateBureauCibilResponse {
  questionKey: string;
  answerKey: string;
  ChallengeConfigGUID: string;
  otp_session_id: string;
  customer_id: number;
  bureau_type: 'CIBIL';
}
interface GenerateBureauExperianResponse {
  otp_session_id: string;
  customer_id: number;
  bureau_type: 'EXPERIAN';
}
type GenerateBureauResponse = GenerateBureauCibilResponse | GenerateBureauExperianResponse;

export interface GenerateBureauInput {
  pan: string;
  phoneNumber: string;
  officialEmail: string;
  pincode: string;
  applicantTypeKey: string; // e.g. "salaried"
  /** The access token from the OTP #1 (dedupe) verify — every authenticated call needs one, and
   * this is the most recent one available at this point in the conversation. */
  token: string;
}

/** validatebureau's own success response returns a FRESH access/refresh token pair — the same
 * pattern as validateotpv2 (see sms.service.ts). Callers should carry these forward as the new
 * "most recent" token for anything after this point (create_anacity_lead, getcustomeroffers,
 * fetchstatusdata). */
export interface BureauPull {
  creditScore: number;
  source: 'bureau' | 'experian';
  accessToken?: string;
  refreshToken?: string;
}

/** The real bureau check is NOT a single request/response like the mock — /generatebureau starts
 * it and comes back with either a CIBIL knowledge-based question (pick the right answer from
 * `error_msg`/the CIBIL bureau's own options) or an Experian mobile OTP, and only /validatebureau
 * (with that question answered, or the OTP entered) actually returns a score. That's a real,
 * interactive conversation turn — it doesn't fit BureauService.pull()'s "one call, get a score
 * back" shape, which is why RealBureauService.pull() below still throws: wiring this in needs a
 * new step type (to show the CIBIL question, or ask for the Experian OTP) designed into the flow
 * first, not just a service swap. generateBureau()/validateBureau() do the actual HTTP work so
 * that step, once designed, has something to call. */
export interface RealBureauApi {
  generateBureau(input: GenerateBureauInput): Promise<GenerateBureauResponse>;
  // otp added 2026-11-06 (confirmed live by Ritendra, not in bureau_api_payloads.txt) — generatebureau
  // ALSO sends an OTP for the CIBIL path, same as Experian; the customer only ever enters that OTP,
  // never the questionKey/answerKey/ChallengeConfigGUID themselves — those are passed through here
  // automatically from whatever generateBureau() returned, never shown to or asked of the customer.
  validateBureauCibil(input: { customerId: number; otpSessionId: string; phoneNumber: string; questionKey: string; answerKey: string; challengeConfigGuid: string; otp: string; token: string }): Promise<BureauPull>;
  validateBureauExperian(input: { customerId: number; otpSessionId: string; phoneNumber: string; otp: string; token: string }): Promise<BureauPull>;
  /** Reads back bureau data ALREADY on file for this customer/product — does not trigger a new
   * pull. See fetchBureauData's own doc comment for the full caveat on the response shape. `pan`
   * added 2026-11-07 — confirmed by a real prod example from Ritendra/Bitsflow that the request
   * includes it alongside customer_id/product_code; the stitched-in 2026-10-31 version never sent
   * it (see the 2026-10-31 confirmed-empty-response test, which also never sent it and still got a
   * clean response — so this was a real gap, not something that happened to still work by luck). */
  fetchBureauData(input: { customerId: number; productCode: string; pan: string; token: string }): Promise<BureauPull | null>;
}

interface ValidateBureauResponse {
  ReferenceKey?: string;
  stageOneId?: string;
  stageTwoId?: string;
  // Confirmed live (2026-11-06, real CIBIL pull against UAT): this comes back as a STRING ("789"),
  // not a number like bureau_api_payloads.txt's sample shows — coerced with Number() at both call
  // sites below rather than trusted as-is.
  bureauScore: number | string;
  bureauType: 'CIBIL' | 'EXPERIAN';
}

export const realBureauApi: RealBureauApi = {
  // retryOnTransient: false throughout — generatebureau starts a real bureau session (CIBIL
  // question or Experian OTP) and validatebureau consumes an answer/OTP attempt against it;
  // retrying either blind after a timeout risks starting a duplicate session or burning a real
  // attempt for an answer that might have already gone through.
  async generateBureau(input) {
    return finfinityClient
      .post<GenerateBureauResponse[]>(
        '/leadflow/generatebureau',
        {
          pan: input.pan,
          phone_number: input.phoneNumber,
          official_email: input.officialEmail,
          pincode: input.pincode,
          applicant_type_key: input.applicantTypeKey,
        },
        { token: input.token, retryOnTransient: false },
      )
      .then((results) => {
        const result = results[0];
        if (!result) throw new Error('generatebureau returned no data');
        return result;
      });
  },
  async validateBureauCibil(input) {
    const results = await finfinityClient.post<[ValidateBureauResponse, { access: string; refresh: string }]>(
      '/leadflow/validatebureau',
      {
        customer_id: input.customerId,
        bureau: 'CIBIL',
        otp_session_id: input.otpSessionId,
        phone_number: input.phoneNumber,
        questionKey: input.questionKey,
        answerKey: input.answerKey,
        ChallengeConfigGUID: input.challengeConfigGuid,
        otp: input.otp,
      },
      { token: input.token, retryOnTransient: false },
    );
    return { creditScore: Number(results[0].bureauScore), source: 'bureau', accessToken: results[1]?.access, refreshToken: results[1]?.refresh };
  },
  async validateBureauExperian(input) {
    const results = await finfinityClient.post<[ValidateBureauResponse, { access: string; refresh: string }]>(
      '/leadflow/validatebureau',
      {
        customer_id: input.customerId,
        bureau: 'EXPERIAN',
        otp_session_id: input.otpSessionId,
        phone_number: input.phoneNumber,
        otp: input.otp,
      },
      { token: input.token, retryOnTransient: false },
    );
    return { creditScore: Number(results[0].bureauScore), source: 'experian', accessToken: results[1]?.access, refreshToken: results[1]?.refresh };
  },
  // STITCHED IN 2026-10-31 ON AN UNCONFIRMED RESPONSE SHAPE — user said "stitch it for now, I'll
  // ask Bitsflow how this works" and will confirm the real shape later. Confirmed LIVE (not
  // guessed) that /leadflow/fetchbureaudata is a READ-ONLY lookup of bureau data already on file —
  // calling it for a customer with no completed bureau pull returns `{data: [], activity:
  // {bureau_score: ""}}` (verified against a real UAT customer, 2026-10-31). The shape when data
  // DOES exist is NOT yet confirmed — the only sample seen so far is a raw CIBIL/TrueLink
  // GetCustomerAssetsResponse (riskScore under Borrower.CreditScore), which the user pasted from
  // an unconfirmed source, not a verified real `data` payload from this endpoint. The parsing below
  // is a best-effort guess at where that shape could land inside `data` — it tries a few plausible
  // nestings and gives up cleanly (returns null, doesn't throw) if none match, rather than silently
  // misreading garbage as a real score. TODO(remind-user): revisit once Bitsflow confirms the real
  // populated response shape, and replace this guessing with the confirmed field path.
  async fetchBureauData(input) {
    const res = await finfinityClient.post<{
      data?: unknown[];
      activity?: { bureau_score?: string | number };
      error_msg?: string;
    }>(
      '/leadflow/fetchbureaudata',
      { customer_id: input.customerId, product_code: input.productCode, pan: input.pan },
      { token: input.token, retryOnTransient: false },
    );

    // Plain path, if Finfinity ever just echoes the score back directly (seen empty as "" for a
    // customer with no data — treat that, and any non-numeric junk, as "nothing here yet").
    const plainScore = Number(res.activity?.bureau_score);
    if (res.activity?.bureau_score && !Number.isNaN(plainScore) && plainScore > 0) {
      return { creditScore: plainScore, source: 'bureau' };
    }

    // Guessed nesting for the raw CIBIL/TrueLink shape the user showed — UNCONFIRMED, see the
    // block comment above. Walks `data[0]` (or `data` itself, if it's an object, not an array) down
    // the same path the sample document used, failing closed (null) if any step doesn't exist
    // rather than throwing on a shape mismatch.
    const first = Array.isArray(res.data) ? res.data[0] : res.data;
    const riskScore = (first as any)?.GetCustomerAssetsResponse?.GetCustomerAssetsSuccess?.Asset?.TrueLinkCreditReport?.Borrower?.CreditScore?.riskScore;
    const parsed = Number(riskScore);
    if (riskScore !== undefined && !Number.isNaN(parsed) && parsed > 0) {
      logger.warn({ event: 'bureau_fetch_unconfirmed_shape_matched', customerId: input.customerId }, 'fetchbureaudata matched the UNCONFIRMED guessed response shape — flag to confirm with Bitsflow whether this is reliable');
      return { creditScore: parsed, source: 'bureau' };
    }

    return null;
  },
};

/** See RealBureauApi's doc comment — the real bureau check needs a new interactive step (a CIBIL
 * question, or an Experian OTP) that doesn't exist in the flow yet, so BureauService.pull() can't
 * be implemented as a drop-in swap the way Dedupe/PAN/Lead/Status could be. generateBureau() and
 * validateBureauCibil/Experian() above are ready for whenever that step gets designed. */
class RealBureauService implements BureauService {
  async pull(pan: string, context?: BureauPullContext): Promise<BureauPull> {
    // Best-effort cheap check (2026-10-31, unconfirmed shape — see fetchBureauData's own comment):
    // if the caller already has a customerId/token (e.g. a lead already created this conversation)
    // and this customer happens to already have a completed real bureau pull on file, use it
    // instead of failing outright. Falls through to the original "not implemented" error below for
    // every other case — a brand-new customer with no prior pull, which is still every customer
    // today, since the interactive generatebureau/validatebureau step isn't wired into the flow yet.
    if (context?.customerId && context?.token) {
      const fetched = await realBureauApi.fetchBureauData({ customerId: context.customerId, productCode: context.productCode ?? 'PL', pan, token: context.token }).catch((err) => {
        logger.warn({ err, event: 'bureau_fetch_failed' }, 'fetchbureaudata call failed — falling back to the usual "not implemented" error');
        return null;
      });
      if (fetched) return fetched;
    }
    throw new Error(
      'RealBureauService.pull() is intentionally not implemented — the real bureau check is a two-step, interactive ' +
        'flow (a CIBIL question or an Experian OTP), not a single score lookup. See realBureauApi in this file and ' +
        "bureau_api_payloads.txt; this needs a new flow step designed before it can be wired in. (fetchbureaudata was " +
        'tried first if a customerId/token was available — see fetchBureauData — but returned nothing for this customer.)',
    );
  }
}

// Same condition that picks RealBureauService over the mock below — exported so flows/homeLoan.ts
// can pick between the real interactive generatebureau/validatebureau steps (2026-11-06) and the
// old placeholder single-OTP-then-mock-score path. A SANDBOX_TEST_PAN/MOBILE customer still always
// gets the mock regardless (see bureauService's own routing below) — this flag only decides which
// UI path a NON-sandbox customer goes through.
export const realBureauFlowEnabled = Boolean(env.FINFINITY_API_BASE_URL) && !env.FINFINITY_BUREAU_MOCK_OVERRIDE;

// See FINFINITY_BUREAU_MOCK_OVERRIDE's comment in config/env.ts — temporary, test-only.
const configuredBureauService: BureauService = env.FINFINITY_API_BASE_URL && !env.FINFINITY_BUREAU_MOCK_OVERRIDE ? new RealBureauService() : new MockBureauService();
const sandboxBureauService: BureauService = new MockBureauService();

// SANDBOX_TEST_PAN (see config/sandbox.ts) always gets a mock score, even when
// configuredBureauService above is the real one — a Google reviewer's test PAN never triggers a
// real CIBIL/Experian pull, in production or anywhere else.
export const bureauService: BureauService = {
  pull: (pan, context) => (isSandboxPan(pan) ? sandboxBureauService.pull(pan, context) : configuredBureauService.pull(pan, context)),
};
