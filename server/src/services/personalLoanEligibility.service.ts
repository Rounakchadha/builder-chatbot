import { env } from '../config/env';
import { logger } from '../lib/logger';

/** Matches FINFINITY-BRE-MAIN/pl-eligibility-precheck's LenderCode exactly — see that project's
 * src/types.ts. Keep these two in sync by hand; they're deliberately separate repos/services.
 * Expanded from 3 to all 11 lenders that project now evaluates (2026-10-27) — see
 * LENDER_DISPLAY_NAME below for the matching customer-facing names. */
export type PlLenderCode =
  | 'POONAWALA_FINCORP'
  | 'TATA_CAPITAL'
  | 'UNITY_SFB'
  | 'ICICI'
  | 'IDFC_FIRST'
  | 'MUTHOOT'
  | 'ADITYA_BIRLA'
  | 'INDUSIND_BANK'
  | 'BAJAJ_FINSERV'
  | 'AXIS_BANK'
  | 'HDFC';

/** The pre-check's own lender codes -> our customer-facing display names. Names below are
 * reasonable guesses at each lender's real brand name — worth a quick human check against how
 * Finfinity/Bitsflow actually label these elsewhere before this reaches a real customer. */
export const LENDER_DISPLAY_NAME: Record<PlLenderCode, string> = {
  POONAWALA_FINCORP: 'Poonawala Fincorp',
  TATA_CAPITAL: 'Tata Capital',
  UNITY_SFB: 'Unity Small Finance Bank',
  ICICI: 'ICICI Bank',
  IDFC_FIRST: 'IDFC First Bank',
  MUTHOOT: 'Muthoot Finance',
  ADITYA_BIRLA: 'Aditya Birla Finance',
  INDUSIND_BANK: 'IndusInd Bank',
  BAJAJ_FINSERV: 'Bajaj Finserv',
  AXIS_BANK: 'Axis Bank',
  HDFC: 'HDFC Bank',
};
const ALL_LENDER_CODES = Object.keys(LENDER_DISPLAY_NAME) as PlLenderCode[];

export type PlEmploymentType = 'salaried' | 'self_employed' | 'business_owner';

/** 'Salaried' -> 'salaried', the two self-employed segments -> the pre-check's narrower union —
 * mirrors dedupe.service.ts's mapSegmentToApplicantType, just for a different target shape. */
export function mapSegmentToEmploymentType(segment: string | undefined): PlEmploymentType {
  if (segment === 'Salaried') return 'salaried';
  if (segment === 'Self-employed professional') return 'self_employed';
  return 'business_owner'; // 'Business owner', or anything unrecognized — same "don't guess wrong direction" default as treating unknown as the stricter non-salaried floor
}

export interface PlEligibilityFacts {
  cibilScore: number;
  monthlyIncome: number;
  employmentType: PlEmploymentType;
  age: number;
  pincode: string;
  loanAmountRequested: number;
  tenureMonths: number;
  existingMonthlyEmi?: number;
  proposedMonthlyEmi?: number;

  // Bureau-depth facts the pre-check's gates can check (see that project's ApplicantFacts) but
  // that nothing in this chatbot can actually supply yet — there's no real CIBIL pull on UAT (see
  // FINFINITY_BUREAU_MOCK_OVERRIDE), so these stay DUMMY (a clean, no-red-flags profile) until a
  // real bureau pull exists in prod. See personalLoan.ts's DUMMY_BUREAU_DEPTH_FACTS — remove this
  // whole block (and that constant) the moment real values are available to send instead.
  bureauVintageMonths?: number;
  isNewToCredit?: boolean;
  monthsAtCurrentEmployer?: number;
  hasDerogatoryFlag?: boolean;
  hasWriteOffOrSettlementLast12m?: boolean;
  isUnderRestructuring?: boolean;
  dpd30PlusRecent?: boolean;
  dpd60PlusRecent?: boolean;
  dpd90PlusRecent?: boolean;
  overdueAmount?: number;
  overdueAmountNonCreditCard?: number;
  overdueAmountCreditCard?: number;
  enquiries7d?: number;
  enquiries30d?: number;
  enquiries90d?: number;
  activePlBlLoansLast6Months?: number;
  hasRestrictedProductExposure?: boolean;
  // Poonawala-specific (its 2026-10-08 PRIME/STPL segment rewrite) — see that project's types.ts.
  dpdAnyInLast6Months?: boolean;
  enquiries1d?: number;
  liveUnsecuredLoansOver1Lac?: number;
  // Unity-specific (its 2026-10-09 "Partner policy (Updated).pdf" rewrite) — see that project's types.ts.
  tradelineCount?: number;
  hasTradelineOverOneLakh?: boolean;
  hasQualifyingCreditCard?: boolean;
  hasSuitFiled?: boolean;
}

export interface PlLenderEligibility {
  lender: PlLenderCode;
  eligible: boolean;
  reasons: string[];
  /** Only present when eligible — this lender's own real (or, for Unity, explicitly placeholder)
   * rate/amount/fee, computed by the pre-check service from its own FOIR ceiling. See that
   * project's gates.ts/pricing.ts. Undefined entirely on the mock service. */
  estimatedRatePercent?: number;
  maxEligibleAmount?: number;
  processingFeePercentMin?: number;
  /** Only present when eligible — this lender's own longest offered tenure for this applicant
   * (already rounded down to a multiple of 12 by the pre-check service), not the fixed tenure we
   * requested. */
  maxTenureMonths?: number;
  /** Only present when eligible (currently only Unity sends one) — months before the loan can be
   * foreclosed/prepaid without penalty. Not surfaced to the customer yet — stored now, shown later
   * (2026-10-09 instruction). */
  lockInPeriodMonths?: number;
}

export interface PersonalLoanEligibilityService {
  /** One call for every lender the pre-check knows about (2026-10-27 — was one HTTP round-trip
   * PER lender, looped by the caller). `facts` was already identical across every one of those
   * per-lender calls (proposedMonthlyEmi is a known, accepted approximation — see
   * buildPrecheckFacts's own comment — not something that actually varied by lender), so batching
   * changes nothing about correctness, only cuts N round-trips down to 1 and means a lender added
   * on the pre-check's side (11, up from 3, as of this date) just shows up here with zero changes
   * needed on our side — we no longer tell it which lenders to check, it tells us. */
  checkAll(facts: PlEligibilityFacts): Promise<PlLenderEligibility[]>;
}

/** Mock — same "no real gate" behavior the flow had before this existed. Used whenever
 * PL_ELIGIBILITY_SERVICE_URL isn't configured, same convention as every other FINFINITY_* mock
 * fallback in this codebase (see eligibility.service.ts/bureau.service.ts/dedupe.service.ts). */
class MockPersonalLoanEligibilityService implements PersonalLoanEligibilityService {
  async checkAll(facts: PlEligibilityFacts): Promise<PlLenderEligibility[]> {
    // Same ballpark as the real pre-check's own numbers, just without any real gate logic behind
    // it — good enough to keep the flow's offer-building code exercised when no URL is configured.
    return ALL_LENDER_CODES.map((lender) => ({
      lender,
      eligible: true,
      reasons: [],
      estimatedRatePercent: 14,
      maxEligibleAmount: Math.min(facts.loanAmountRequested, facts.monthlyIncome * 10),
      maxTenureMonths: facts.tenureMonths,
    }));
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

/** Real — calls the standalone pre-check service (a separate repo/project:
 * FINFINITY-BRE-MAIN/pl-eligibility-precheck — NOT the main BRE itself, and NOT the Finfinity
 * backend finfinityClient.ts talks to).
 *
 * Fails CLOSED on any network/parse error (security-review finding, 2026-10-23 — was "fail open",
 * approving every lender at up to 10x monthly income with a fabricated 14% rate whenever this
 * pre-check was merely unreachable, using hardcoded "clean profile" bureau-depth facts that were
 * never the real customer's history either way). An outage here used to silently manufacture a real-
 * looking approved offer instead of admitting nothing was actually checked — the opposite of safe.
 * This service is also no longer the customer-facing path at all when PL_REAL_FINANCER_CHAIN_ENABLED
 * is on (see personalLoan.ts's runOwnBreComparison) — it only runs in the background now, purely to
 * compare against the real chain's numbers, so failing closed here has no customer-facing cost
 * either way, only a (correctly) blank comparison row instead of a fabricated one. */
class RealPersonalLoanEligibilityService implements PersonalLoanEligibilityService {
  async checkAll(facts: PlEligibilityFacts): Promise<PlLenderEligibility[]> {
    try {
      const res = await fetch(`${env.PL_ELIGIBILITY_SERVICE_URL}/eligibility/personal-loan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.PL_ELIGIBILITY_API_KEY ? { 'x-internal-api-key': env.PL_ELIGIBILITY_API_KEY } : {}),
        },
        // No `lenders` filter — omitting it (rather than listing the ones we happen to know about)
        // is what makes this pick up a lender added on the pre-check's side with zero changes here.
        body: JSON.stringify({ facts }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`pl-eligibility-precheck returned HTTP ${res.status}`);
      const body = (await res.json()) as { results?: PlLenderEligibility[] };
      if (!body.results?.length) throw new Error('pl-eligibility-precheck returned no results at all');
      return body.results.map((result) => ({
        lender: result.lender,
        eligible: result.eligible,
        reasons: result.reasons,
        estimatedRatePercent: result.estimatedRatePercent,
        maxEligibleAmount: result.maxEligibleAmount,
        processingFeePercentMin: result.processingFeePercentMin,
        maxTenureMonths: result.maxTenureMonths,
        lockInPeriodMonths: result.lockInPeriodMonths,
      }));
    } catch (err) {
      logger.error({ err, event: 'pl_eligibility_check_failed' }, 'personal loan eligibility pre-check failed — treating every lender as NOT eligible (fail closed)');
      // Fail CLOSED (2026-10-23) — an outage here is not a reason to manufacture an approved offer
      // at up to 10x income using a fake 14% rate and hardcoded "clean profile" facts; that's exactly
      // the "approves when things fail" bug the security review flagged. No eligibility data exists
      // for ANY lender when the pre-check couldn't actually run, so say so for every one of them
      // (rather than silently returning an empty list, which would look like "nobody was checked"
      // instead of "the check itself failed").
      return ALL_LENDER_CODES.map((lender) => ({ lender, eligible: false, reasons: ['Eligibility pre-check was unavailable'] }));
    }
  }
}

export const personalLoanEligibilityService: PersonalLoanEligibilityService = env.PL_ELIGIBILITY_SERVICE_URL
  ? new RealPersonalLoanEligibilityService()
  : new MockPersonalLoanEligibilityService();
