import type { LenderOffer, Segment } from '@builder-chatbot/shared';
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
  /** "Self-occupied" / "Rented" / "Vacant" (LAP only) — mapped to this endpoint's own Title Case
   * values (see RealEligibilityService). */
  occupancy?: string;
  /** True for a balance-transfer loan type — mapped to this endpoint's bt_type field. */
  isBalanceTransfer?: boolean;
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

/** "Self-occupied" -> "Self Occupied", etc. — confirmed live (2026-10-16) that getcustomeroffers
 * wants its OWN Title Case / spaced format for this, different from updatelead's lowercase/
 * underscored "self_occupied". Two separate fields on two separate endpoints, two separate
 * formats — not a typo, confirmed by testing both. */
function toTitleCaseSpaced(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Real BRE/lender-offers API — POST /leadflow/getcustomeroffers. For HL/LAP (the only products
 * this flow supports today) it's keyed by leadid, not by the raw income/segment/product this
 * interface was designed around — the backend pulls those straight from the lead it already has.
 * flows/homeLoan.ts's computeResultPayload already creates the lead before calling this (see
 * ensureLead there), so `input.leadId` is always the real lead's id by the time evaluate() runs.
 *
 * income/emi ARE pushed onto the lead before this ever runs — see updateLead's monthly_income/
 * existing_emi in lead.service.ts and syncLeadFinancials in flows/homeLoan.ts, which both
 * computeResultPayload and recomputeEligibility call before getting here.
 *
 * CRITICAL FIX (2026-10-16): this call was crashing for every LAP lead with `EXEC_ERR: "cannot
 * unpack non-iterable NoneType object"` — confirmed live that it's NOT about collateral_type being
 * missing/invalid on the lead (as first suspected and reported to Bitsflow). The real cause: this
 * endpoint needs a much richer payload than just {leadid, product_code} — ownership/secure_loan/
 * company_type/occupancy_type/property_type/builder_name/corporate_name/bt_type/campaign_code/
 * filter/collateral_type ALL need to be in THIS request body directly (not just synced onto the
 * lead beforehand via updatelead). Confirmed live: sending these (even with collateral_type as a
 * blank string) returns a full, real 20-lender offer list with zero crash — reproduced on a fresh
 * lead end-to-end. Most of these fields (ownership, secure_loan, company_type, builder_name,
 * corporate_name) have no real collected-data source in this flow yet and are sent as fixed
 * individual-applicant defaults; swap them for real values if/when this flow ever supports
 * non-individual or company-owned-property applicants. */
class RealEligibilityService implements EligibilityService {
  async evaluate(input: EligibilityInput): Promise<EligibilityResult> {
    if (!input.leadId) {
      throw new Error('RealEligibilityService.evaluate() needs input.leadId — getcustomeroffers requires an already-created lead. See computeResultPayload in flows/homeLoan.ts.');
    }

    const results = await finfinityClient.post<GetCustomerOffersHlResponse[]>(
      '/leadflow/getcustomeroffers',
      {
        leadid: Number(input.leadId),
        product_code: input.productCode,
        ownership: 'Individual',
        secure_loan: 'No',
        company_type: '',
        occupancy_type: input.occupancy ? toTitleCaseSpaced(input.occupancy) : '',
        // Construction status, not collected in this flow yet — "Ready to Move" is the common
        // default and what both confirmed-working live examples used.
        property_type: 'Ready to Move',
        builder_name: '',
        corporate_name: '',
        bt_type: input.isBalanceTransfer ? 'BT' : '',
        campaign_code: 'anacity',
        filter: {},
        collateral_type: '',
      },
      { token: input.token },
    );
    const data = results[0]?.data?.[0];
    if (!data) throw new Error('getcustomeroffers returned no data');

    const offers: LenderOffer[] = data.final_lender_list
      .map((l) => ({
        name: l.lender_name,
        amountLakh: l.eligibility_amount / 100000,
        emi: l.emi,
        rate: String(l.rate),
        // Security-review finding, 2026-10-23: was Math.round, which can round UP — a real max
        // tenure of e.g. 211 months became "18 years" (216 months), overstating what this lender
        // actually offers. Math.floor never overstates it.
        tenureYears: Math.floor(l.max_tenure / 12),
      }))
      // Security-review finding, 2026-10-23: this used to trust getcustomeroffers already returned
      // lenders best-first and just took offers[0] — nothing actually guaranteed that ordering.
      .sort((a, b) => b.amountLakh - a.amountLakh);

    if (offers.length === 0) {
      return { eligible: false, emi: 0, tenureYears: 0, loanAmountLakh: '0' };
    }
    const best = offers[0];
    return { eligible: true, emi: best.emi, tenureYears: best.tenureYears, loanAmountLakh: String(best.amountLakh), offers };
  }
}

export const eligibilityService: EligibilityService = env.FINFINITY_OFFERS_ENABLED ? new RealEligibilityService() : new MockEligibilityService();
