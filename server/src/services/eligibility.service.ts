import type { LenderOffer, Segment } from '@loan-chatbot/shared';
import { env } from '../config/env';
import { computeEligibility, computeLenderEligibility, LENDERS } from '../flow-engine/eligibility';
import { finfinityClient } from './finfinityClient';

export interface EligibilityInput {
  segment: Segment;
  product: string;
  income: number;
  emi: number;
  seedKey: string; // used only by the mock to deterministically vary lender offers
  /** The real backend's own lead id — required for a real getcustomeroffers call (HL/LAP use
   * leadid, not raw income/segment/product; the backend pulls those from the lead itself). Not
   * used by the mock. */
  leadId?: string;
  /** The most recent access token captured this conversation. Not used by the mock. */
  token?: string;
  /** The real backend's product code (e.g. "HL") — undocumented for this specific endpoint (the
   * docs only show it for the PL/EL/AL flow), but confirmed live (2026-09-23) that HL/LAP actually
   * needs it too: omitting it crashes getcustomeroffers with a Python KeyError, `'product_code'`. */
  productCode?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  emi: number;
  tenureYears: number;
  loanAmountLakh: string;
  offers?: LenderOffer[];
}

export interface EligibilityService {
  evaluate(input: EligibilityInput): Promise<EligibilityResult>;
}

/**
 * NOTE: every number this produces is a placeholder. The real eligibility figures, interest
 * rates, and lender-specific offers are meant to come from the main app's BRE (Business Rule
 * Engine) API — that integration hasn't happened yet. This mock keeps the flow end-to-end testable
 * in the meantime using the same FOIR-based formula the original prototype used, with lender offers
 * deterministically varied by a hash of (lender name + PAN/mobile) so results are stable per
 * customer but differ across lenders.
 */
class MockEligibilityService implements EligibilityService {
  async evaluate(input: EligibilityInput): Promise<EligibilityResult> {
    const outcome = computeEligibility(input);
    if (!outcome.eligible) return outcome;

    const offers = LENDERS.map((l) => computeLenderEligibility(input, l)).sort((x, y) => y.amountLakh - x.amountLakh);
    return { ...outcome, offers };
  }
}

interface FinalLenderOffer {
  lender_name: string;
  eligibility_amount: number;
  rate: number;
  emi: number;
  min_tenure: number;
  max_tenure: number;
  ltv: number;
}
interface RejectedLenderOffer {
  lender_name: string;
  rejection_reason: string;
}
/** Confirmed live (2026-09-23): the real payload is nested one level deeper than the docs' example
 * showed — the lender lists live at `data[0].data[0]`, not `data[0]`. finfinityClient already
 * unwraps the outer envelope, so this type is that OUTER array's element shape; `result[0].data[0]`
 * below reaches the actual lender lists. */
interface GetCustomerOffersHlResponse {
  data: Array<{
    final_lender_list: FinalLenderOffer[];
    rejected_lender_list: RejectedLenderOffer[];
    exec_status: string;
  }>;
  error_msg: string;
  error_code: string;
}

/** Real BRE/lender-offers API — POST /leadflow/getcustomeroffers. For HL/LAP (the only products
 * this flow supports today) it's keyed by leadid, not by the raw income/segment/product this
 * interface was designed around — the backend pulls those straight from the lead it already has.
 * flows/homeLoan.ts's computeResultPayload already creates the lead before calling this (see
 * ensureLead there), so `input.leadId` is always the real lead's id by the time evaluate() runs.
 *
 * income/emi ARE pushed onto the lead before this ever runs — see updateLead's monthly_income/
 * existing_emi in lead.service.ts and syncLeadFinancials in flows/homeLoan.ts, which both
 * computeResultPayload and recomputeEligibility call before getting here. */
class RealEligibilityService implements EligibilityService {
  async evaluate(input: EligibilityInput): Promise<EligibilityResult> {
    if (!input.leadId) {
      throw new Error('RealEligibilityService.evaluate() needs input.leadId — getcustomeroffers requires an already-created lead. See computeResultPayload in flows/homeLoan.ts.');
    }

    const results = await finfinityClient.post<GetCustomerOffersHlResponse[]>(
      '/leadflow/getcustomeroffers',
      { leadid: Number(input.leadId), product_code: input.productCode },
      { token: input.token },
    );
    const data = results[0]?.data?.[0];
    if (!data) throw new Error('getcustomeroffers returned no data');

    const offers: LenderOffer[] = data.final_lender_list.map((l) => ({
      name: l.lender_name,
      amountLakh: l.eligibility_amount / 100000,
      emi: l.emi,
      rate: String(l.rate),
      tenureYears: Math.round(l.max_tenure / 12),
    }));

    if (offers.length === 0) {
      return { eligible: false, emi: 0, tenureYears: 0, loanAmountLakh: '0' };
    }
    const best = offers[0];
    return { eligible: true, emi: best.emi, tenureYears: best.tenureYears, loanAmountLakh: String(best.amountLakh), offers };
  }
}

export const eligibilityService: EligibilityService = env.FINFINITY_OFFERS_ENABLED ? new RealEligibilityService() : new MockEligibilityService();
