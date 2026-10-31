import type { LenderOffer } from '@builder-chatbot/shared';
import { env } from '../config/env';
import { finfinityClient } from './finfinityClient';

/**
 * Finfinity's own real Personal Loan BRE chain — confirmed live end-to-end against lead 76071
 * (2026-10-21), a real alternative to the standalone FINFINITY-BRE-MAIN/pl-eligibility-precheck
 * microservice (personalLoanEligibility.service.ts). NOT the active path yet — gated behind
 * PL_REAL_FINANCER_CHAIN_ENABLED, default off (direct instruction: "do not run our bre yet. ill
 * tell u when to switch between the two"). The full chain, in order:
 * 1. POST /leadflow/create_anacity_lead (product_code 'PL') — already generic in lead.service.ts.
 * 2. POST /leadflow/financerwiseeligibility — ALL lenders' real eligibility in ONE call (this
 *    service's getEligibility), replacing the pre-check microservice's one-call-per-lender loop.
 * 3+4. POST /leadflow/setcorpamtten then POST /leadflow/pl_financer_offer, once the customer picks
 *    one lender's offer (this service's confirmOffer) — writes the chosen amount/tenure/lender
 *    onto the lead, then recomputes the final confirmed numbers for exactly that selection.
 * 5. POST /leadflow/setbrefinanceroffertenure — already generic as leadService.setOfferTenure.
 */
export interface PlFinancerEligibilityInput {
  customerId: number;
  leadId: string;
  monthlyIncome: number;
  obligation: number;
  bureauScore: number;
  token?: string;
}

/** The exact per-lender shape financerwiseeligibility returns — kept around in full (not just
 * mapped to LenderOffer) so confirmOffer can forward a chosen lender's own numbers straight back to
 * setcorpamtten/pl_financer_offer without us having to reconstruct or guess at them later. `pf`'s
 * format is inconsistent across lenders in the live response (percentages like "4%"/"1.5%" for
 * some, flat rupee amounts like "5999"/"10000" for others) — forwarded as-is rather than parsed,
 * since nothing here needs to interpret it, only pass it through to the same two calls that already
 * accept whatever shape financerwiseeligibility itself produced for that lender. */
export interface PlFinancerLenderEntry {
  lender_name: string;
  min_tenure: number;
  max_tenure: number;
  min_loan_amount: number;
  max_loan_amount: number;
  pf: string;
  rate: number;
  emi: number;
  eligibility_amount: number;
  hasMultipleTenure: string;
  [key: string]: unknown;
}

/** One lender's outcome from either PL BRE engine, win or lose — the shape stored for the
 * shadow-mode comparison (see flows/personalLoan.ts's runOwnBreComparison). Was previously just the
 * approved-offer list; a rejected lender left no trace at all, not even that it was checked
 * (2026-10-24). `raw` is always the untouched per-lender payload, so nothing is lost even if
 * `reasons`' field-name guess below turns out wrong. */
export interface PlLenderComparisonResult {
  lender: string;
  eligible: boolean;
  reasons: string[];
  amountLakh?: number;
  rate?: string;
  tenureYears?: number;
  raw?: unknown;
}

/** financerwiseeligibility's rejected_lender_list has never had its reason field confirmed against
 * a live rejected response (2026-10-24) — Bitsflow's docs don't name one. Tries the common
 * candidates in order and takes the first non-empty string; `raw` on the result above is the
 * fallback source of truth until this is confirmed live. */
const REJECTION_REASON_FIELDS = ['rejection_reason', 'reason', 'remarks', 'rej_reason', 'message'] as const;
function extractRejectionReasons(raw: Record<string, unknown>): string[] {
  for (const field of REJECTION_REASON_FIELDS) {
    const v = raw[field];
    if (typeof v === 'string' && v.trim()) return [v.trim()];
  }
  return [];
}

export interface PlFinancerEligibilityResult {
  offers: LenderOffer[];
  /** Keyed by lender_name — confirmOffer needs the matching raw entry for whichever one the
   * customer picks. */
  rawByLender: Record<string, PlFinancerLenderEntry>;
  /** Every lender this chain attempted, approved or rejected — for the shadow-mode comparison only,
   * never shown to the customer (that's `offers` above, unchanged). */
  fullResults: PlLenderComparisonResult[];
}

export interface PlFinancerConfirmInput {
  leadId: string;
  /** The exact raw entry this offer came from (see rawByLender above) — its own rate/pf/eligible
   * amount/tenure are forwarded straight through rather than re-derived. */
  lender: PlFinancerLenderEntry;
  /** What the customer actually asked for — may differ from the lender's own max eligible
   * amount/tenure (e.g. they want less than they're eligible for). */
  requestedLoanAmount: number;
  requestedTenureMonths: number;
  token?: string;
}

export interface PersonalLoanFinancerService {
  getEligibility(input: PlFinancerEligibilityInput): Promise<PlFinancerEligibilityResult>;
  confirmOffer(input: PlFinancerConfirmInput): Promise<void>;
}

interface FinancerwiseEligibilityResponse {
  data: Array<{
    final_lender_list: PlFinancerLenderEntry[];
    rejected_lender_list: PlFinancerLenderEntry[];
    exec_status: string;
  }>;
  error_msg: string;
  error_code: string;
}

function toLenderOffer(l: PlFinancerLenderEntry): LenderOffer {
  return {
    name: l.lender_name,
    amountLakh: Number((l.eligibility_amount / 100_000).toFixed(2)),
    emi: Math.round(l.emi),
    rate: String(l.rate),
    tenureYears: Math.round(l.max_tenure / 12),
  };
}

class RealPersonalLoanFinancerService implements PersonalLoanFinancerService {
  async getEligibility(input: PlFinancerEligibilityInput): Promise<PlFinancerEligibilityResult> {
    const results = await finfinityClient.post<FinancerwiseEligibilityResponse[]>(
      '/leadflow/financerwiseeligibility',
      {
        customer_id: input.customerId,
        leadId: Number(input.leadId),
        monthly_income: input.monthlyIncome,
        obligation: input.obligation,
        bureau_score: input.bureauScore,
      },
      { token: input.token },
    );
    const data = results[0]?.data?.[0];
    if (!data) return { offers: [], rawByLender: {}, fullResults: [] };

    const rawByLender: Record<string, PlFinancerLenderEntry> = {};
    for (const l of data.final_lender_list) rawByLender[l.lender_name] = l;

    const fullResults: PlLenderComparisonResult[] = [
      ...data.final_lender_list.map((l): PlLenderComparisonResult => ({
        lender: l.lender_name,
        eligible: true,
        reasons: [],
        amountLakh: Number((l.eligibility_amount / 100_000).toFixed(2)),
        rate: String(l.rate),
        tenureYears: Math.round(l.max_tenure / 12),
        raw: l,
      })),
      ...(data.rejected_lender_list ?? []).map((l): PlLenderComparisonResult => ({
        lender: l.lender_name,
        eligible: false,
        reasons: extractRejectionReasons(l as unknown as Record<string, unknown>),
        raw: l,
      })),
    ];

    return {
      offers: data.final_lender_list.map(toLenderOffer).sort((a, b) => b.amountLakh - a.amountLakh),
      rawByLender,
      fullResults,
    };
  }

  async confirmOffer(input: PlFinancerConfirmInput): Promise<void> {
    const { lender } = input;
    await finfinityClient.post(
      '/leadflow/setcorpamtten',
      {
        leadid: Number(input.leadId),
        req_loan_amount: String(input.requestedLoanAmount),
        req_tenure: String(input.requestedTenureMonths),
        emi: String(lender.emi),
        lender_name: lender.lender_name,
        roi: String(lender.rate),
        pf_amount: String(lender.pf),
        eligible_loan_amount: String(lender.eligibility_amount),
        eligible_tenure: String(lender.max_tenure),
      },
      { token: input.token },
    );
    // Recomputes the final, confirmed numbers for exactly this lender/amount/tenure — not parsed
    // here since nothing downstream reads it yet beyond confirming the save went through; add
    // parsing if/when those final numbers need to be shown back to the customer.
    await finfinityClient.post(
      '/leadflow/pl_financer_offer',
      {
        leadid: Number(input.leadId),
        loan_amount: input.requestedLoanAmount,
        rate: lender.rate,
        tenure: input.requestedTenureMonths,
        max_tenure: lender.max_tenure,
        max_loan_amount: lender.eligibility_amount,
        pf: lender.pf,
      },
      { token: input.token },
    );
  }
}

/** Mock — same "nothing real without a configured flag" spirit as every other FINFINITY_ /
 * PL_ELIGIBILITY_ toggle in this codebase. Returns no offers rather than fabricating any, since
 * this service is only ever consulted when PL_REAL_FINANCER_CHAIN_ENABLED is explicitly on. */
class MockPersonalLoanFinancerService implements PersonalLoanFinancerService {
  async getEligibility(): Promise<PlFinancerEligibilityResult> {
    return { offers: [], rawByLender: {}, fullResults: [] };
  }
  async confirmOffer(): Promise<void> {}
}

export const personalLoanFinancerService: PersonalLoanFinancerService = env.PL_REAL_FINANCER_CHAIN_ENABLED
  ? new RealPersonalLoanFinancerService()
  : new MockPersonalLoanFinancerService();
