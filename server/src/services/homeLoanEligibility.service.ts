import { env } from '../config/env';
import { logger } from '../lib/logger';

/** Matches FINFINITY-BRE-MAIN/hl-eligibility-precheck's LenderCode exactly — see that project's
 * src/types.ts. Keep these two in sync by hand; they're deliberately separate repos/services.
 * Codes are suffixed/named distinctly from PlLenderCode even for the same bank (e.g.
 * `AXIS_BANK_HL` here vs. `AXIS_BANK` for Personal Loan) — a bank's Home Loan and Personal Loan
 * products are different products with different real policies. */
export type HlLenderCode =
  | 'ADITYA_BIRLA_HOUSING'
  | 'AXIS_BANK_HL'
  | 'BAJAJ_HOUSING_FINANCE'
  | 'FEDERAL_BANK_HL'
  | 'HDFC_BANK_HL'
  | 'ICICI_BANK_HL'
  | 'ICICI_HFC'
  | 'IDFC_FIRST_BANK_HL'
  | 'IIFL_HL'
  | 'LT_HOUSING_FINANCE'
  | 'PIRAMAL_HOUSING'
  | 'PNB_HOUSING'
  | 'RBL_BANK_HL'
  | 'TATA_CAPITAL_HOUSING'
  | 'DBS_HL'
  | 'KARUR_VYSYA_HL'
  | 'HSBC_HL'
  | 'JIO_CREDIT_LIMITED_HL'
  | 'SBI_HL'
  | 'BANK_OF_BARODA_HL'
  | 'AADHAR_HOUSING';

/** The pre-check's own lender codes -> our customer-facing display names — taken directly from
 * each lender's `displayName` field in that project's lenders-data/*.ts. */
export const HL_LENDER_DISPLAY_NAME: Record<HlLenderCode, string> = {
  ADITYA_BIRLA_HOUSING: 'Aditya Birla Housing Finance',
  AXIS_BANK_HL: 'Axis Bank',
  BAJAJ_HOUSING_FINANCE: 'Bajaj Housing Finance',
  FEDERAL_BANK_HL: 'Federal Bank',
  HDFC_BANK_HL: 'HDFC Bank',
  ICICI_BANK_HL: 'ICICI Bank Ltd',
  ICICI_HFC: 'ICICI HFC',
  IDFC_FIRST_BANK_HL: 'IDFC First Bank',
  IIFL_HL: 'IIFL',
  LT_HOUSING_FINANCE: 'L&T Housing Finance',
  PIRAMAL_HOUSING: 'Piramal Housing',
  PNB_HOUSING: 'PNB Housing',
  RBL_BANK_HL: 'RBL Bank',
  TATA_CAPITAL_HOUSING: 'Tata Capital Housing',
  DBS_HL: 'DBS',
  KARUR_VYSYA_HL: 'Karur Vysya',
  HSBC_HL: 'HSBC',
  JIO_CREDIT_LIMITED_HL: 'Jio Credit Limited',
  SBI_HL: 'State Bank of India',
  BANK_OF_BARODA_HL: 'Bank of Baroda',
  AADHAR_HOUSING: 'Aadhar Housing',
};
const ALL_HL_LENDER_CODES = Object.keys(HL_LENDER_DISPLAY_NAME) as HlLenderCode[];

export type HlEmploymentType = 'salaried' | 'self_employed' | 'business_owner';
export type HlPropertyType = 'ready_to_move' | 'under_construction' | 'resale' | 'plot_and_construction';

/** 'Salaried' -> 'salaried', the two self-employed segments -> the pre-check's narrower union —
 * mirrors personalLoanEligibility.service.ts's mapSegmentToEmploymentType exactly. */
export function mapSegmentToHlEmploymentType(segment: string | undefined): HlEmploymentType {
  if (segment === 'Salaried') return 'salaried';
  if (segment === 'Self-employed professional') return 'self_employed';
  return 'business_owner';
}

/** Maps this flow's own propertyType display values onto the pre-check's real DMN-sourced union
 * (see that project's updatelead `property_type` table in api-fin/ALL_CONFIRMED_APIS.md for the
 * REAL Finfinity/Bitsflow backend's own separate values — not the same union, deliberately not
 * conflated here). Defaults to 'ready_to_move' (the most common, least restrictive case) for any
 * value this flow doesn't recognize, rather than failing the whole eligibility call outright. */
export function mapPropertyTypeToHl(propertyType: string | undefined): HlPropertyType {
  const v = (propertyType ?? '').toLowerCase();
  if (v.includes('plot')) return 'plot_and_construction';
  if (v.includes('resale')) return 'resale';
  if (v.includes('construction')) return 'under_construction';
  return 'ready_to_move';
}

export interface HlEligibilityFacts {
  cibilScore: number;
  monthlyIncome: number;
  employmentType: HlEmploymentType;
  age: number;
  pincode: string;
  propertyValue: number;
  loanAmountRequested: number;
  tenureMonths: number;
  propertyType: HlPropertyType;
  existingMonthlyEmi?: number;
  proposedMonthlyEmi?: number;
}

export interface HlLenderEligibility {
  lender: HlLenderCode;
  eligible: boolean;
  reasons: string[];
  warnings?: string[];
  /** Only present when eligible — this lender's own real rate, computed by the pre-check from its
   * own DMN-sourced rate tiers (CIBIL/income-tiered where the source has it, flat where it
   * doesn't). See that project's lenders-data/*.ts. */
  estimatedRatePercent?: number;
  maxEligibleAmount?: number;
  /** Only one of these two is ever set for a given lender — many Home Loan lenders quote a flat
   * rupee processing fee instead of a percentage (unlike every PL lender, which only ever quoted
   * percentages). */
  processingFeePercentMin?: number;
  processingFeeFlatRupees?: number;
  maxTenureMonths?: number;
}

export interface HomeLoanEligibilityService {
  /** One call for every lender the pre-check knows about — same "it tells us which lenders exist,
   * we don't tell it" convention as PersonalLoanEligibilityService.checkAll. */
  checkAll(facts: HlEligibilityFacts): Promise<HlLenderEligibility[]>;
}

/** Mock — same "no real gate" behavior as MockPersonalLoanEligibilityService. Used whenever
 * HL_ELIGIBILITY_SERVICE_URL isn't configured. */
class MockHomeLoanEligibilityService implements HomeLoanEligibilityService {
  async checkAll(facts: HlEligibilityFacts): Promise<HlLenderEligibility[]> {
    return ALL_HL_LENDER_CODES.map((lender) => ({
      lender,
      eligible: true,
      reasons: [],
      estimatedRatePercent: 8.5,
      maxEligibleAmount: Math.min(facts.loanAmountRequested, facts.propertyValue * 0.8, facts.monthlyIncome * 60),
      maxTenureMonths: facts.tenureMonths,
    }));
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

/** Real — calls the standalone pre-check service (a separate repo/project:
 * FINFINITY-BRE-MAIN/hl-eligibility-precheck — NOT the main BRE itself, and NOT the Finfinity
 * backend finfinityClient.ts talks to, and NOT the PL pre-check either).
 *
 * Fails CLOSED on any network/parse error, same discipline as RealPersonalLoanEligibilityService
 * (security-review finding, 2026-10-23, for the PL side) — an outage here is not a reason to
 * manufacture an approved offer; every lender comes back `eligible: false` with a reason saying the
 * check itself didn't run, never a fabricated number. This service is purely a background/shadow
 * comparison alongside the real `getcustomeroffers` call (see flows/homeLoan.ts's
 * runOwnHlBreComparison) — it is NOT the customer-facing path, so failing closed here has zero
 * customer-facing cost, only a (correctly) blank comparison row instead of a fabricated one. */
class RealHomeLoanEligibilityService implements HomeLoanEligibilityService {
  async checkAll(facts: HlEligibilityFacts): Promise<HlLenderEligibility[]> {
    try {
      const res = await fetch(`${env.HL_ELIGIBILITY_SERVICE_URL}/eligibility/home-loan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.HL_ELIGIBILITY_API_KEY ? { 'x-internal-api-key': env.HL_ELIGIBILITY_API_KEY } : {}),
        },
        // No `lenders` filter — same reasoning as the PL side: a lender added on the pre-check's
        // side needs zero changes here.
        body: JSON.stringify({ facts }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`hl-eligibility-precheck returned HTTP ${res.status}`);
      const body = (await res.json()) as { results?: HlLenderEligibility[] };
      if (!body.results?.length) throw new Error('hl-eligibility-precheck returned no results at all');
      return body.results.map((result) => ({
        lender: result.lender,
        eligible: result.eligible,
        reasons: result.reasons,
        warnings: result.warnings,
        estimatedRatePercent: result.estimatedRatePercent,
        maxEligibleAmount: result.maxEligibleAmount,
        processingFeePercentMin: result.processingFeePercentMin,
        processingFeeFlatRupees: result.processingFeeFlatRupees,
        maxTenureMonths: result.maxTenureMonths,
      }));
    } catch (err) {
      logger.error({ err, event: 'hl_eligibility_check_failed' }, 'home loan eligibility pre-check failed — treating every lender as NOT eligible (fail closed)');
      return ALL_HL_LENDER_CODES.map((lender) => ({ lender, eligible: false, reasons: ['Eligibility pre-check was unavailable'] }));
    }
  }
}

export const homeLoanEligibilityService: HomeLoanEligibilityService = env.HL_ELIGIBILITY_SERVICE_URL
  ? new RealHomeLoanEligibilityService()
  : new MockHomeLoanEligibilityService();
