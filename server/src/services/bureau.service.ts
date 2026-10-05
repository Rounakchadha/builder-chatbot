import { env } from '../config/env';
import { hashCode } from '../flow-engine/eligibility';
import { maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { finfinityClient } from './finfinityClient';

/** Extra identity fields the real CIBIL/Experian pull needs alongside PAN — not used by the mock,
 * which only needs the PAN to generate a deterministic score. */
export interface BureauPullContext {
  dob?: string;
  pincode?: string;
  email?: string;
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
  validateBureauCibil(input: { customerId: number; otpSessionId: string; phoneNumber: string; questionKey: string; answerKey: string; challengeConfigGuid: string; token: string }): Promise<BureauPull>;
  validateBureauExperian(input: { customerId: number; otpSessionId: string; phoneNumber: string; otp: string; token: string }): Promise<BureauPull>;
}

interface ValidateBureauResponse {
  ReferenceKey?: string;
  stageOneId?: string;
  stageTwoId?: string;
  bureauScore: number;
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
      },
      { token: input.token, retryOnTransient: false },
    );
    return { creditScore: results[0].bureauScore, source: 'bureau', accessToken: results[1]?.access, refreshToken: results[1]?.refresh };
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
    return { creditScore: results[0].bureauScore, source: 'experian', accessToken: results[1]?.access, refreshToken: results[1]?.refresh };
  },
};

/** See RealBureauApi's doc comment — the real bureau check needs a new interactive step (a CIBIL
 * question, or an Experian OTP) that doesn't exist in the flow yet, so BureauService.pull() can't
 * be implemented as a drop-in swap the way Dedupe/PAN/Lead/Status could be. generateBureau() and
 * validateBureauCibil/Experian() above are ready for whenever that step gets designed. */
class RealBureauService implements BureauService {
  async pull(_pan: string, _context?: BureauPullContext): Promise<BureauPull> {
    throw new Error(
      'RealBureauService.pull() is intentionally not implemented — the real bureau check is a two-step, interactive ' +
        'flow (a CIBIL question or an Experian OTP), not a single score lookup. See realBureauApi in this file and ' +
        "bureau_api_payloads.txt; this needs a new flow step designed before it can be wired in.",
    );
  }
}

// See FINFINITY_BUREAU_MOCK_OVERRIDE's comment in config/env.ts — temporary, test-only.
export const bureauService: BureauService = env.FINFINITY_API_BASE_URL && !env.FINFINITY_BUREAU_MOCK_OVERRIDE ? new RealBureauService() : new MockBureauService();
