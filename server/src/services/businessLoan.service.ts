import { env } from '../config/env';
import { finfinityClient, FinfinityApiError } from './finfinityClient';
import { generateLeadId, pickRm } from '../flows/rm';
import { ensureLeadOnce } from './lead.service';
import { maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';

/** Real master-data IDs confirmed live against UAT (2026-10-15, partner-provided) for
 * businessloandtl's nature_of_business/profession_type/loan_purpose fields — these are NOT
 * arbitrary; the endpoint rejects unrecognized IDs with a generic "Error in saving"/CUSTSRV143 and
 * no detail, confirmed by testing placeholder value `1` for all three before these were shared.
 *
 * `BUSINESS_LOAN_PURPOSES` (shared/src/index.ts) maps directly onto real `BL_LoanPurpose` rows.
 * `INDUSTRY_TYPES` maps onto real `BusinessNatureType` rows.
 * `BUSINESS_TYPES` (the applicant's own role, not strictly the entity type) maps onto
 * `BLProfessionType` rows — an INTERPRETIVE mapping, not a given one: that master list describes a
 * person's role (proprietor/director/partner/OPC), not the six legal entity types we ask for, so
 * "Partnership"/"LLP" both map to the same "partner" row, and "Private limited"/"Public limited"
 * both map to "director" — the master list has no finer distinction than this.
 */
const NATURE_OF_BUSINESS_ID: Record<string, number> = {
  Manufacturing: 465,
  Trading: 464,
  Services: 466,
};

// BLProfessionType (497/562/563/564, later 409/492/493/494) is no longer used at all (2026-10-21
// direct instruction: "we have to send only constitution type 121 123 and 209" / "remove the old
// codes") — businessloandtl now sends `constitution_type` instead of `profession_type`, sourced
// from this separate ConstitutionType master table. Only these 3 ids were given, matching our 3
// supported entity categories (individual/company/partnership); OPC/Public limited reuse the
// "private_limited" row since no distinct code was given for either.
const CONSTITUTION_TYPE_ID: Record<string, number> = {
  Proprietorship: 121, // "proprietorship"
  Partnership: 209, // "partnership_firm"
  LLP: 209, // same as above — no distinct LLP row given
  'Private limited': 123, // "private_limited"
  'Public limited': 123, // same as above — no distinct row given
  OPC: 123, // same as above — no distinct row given
};

// "Others"/"Other Business Purpose" (ids 29/30) are deliberately never sent — every one of our own
// options maps to a specific real purpose below; there is no catch-all fallback to either.
const LOAN_PURPOSE_ID: Record<string, number> = {
  'Working capital': 24, // "Working Capital Requirements"
  // The real master list has one combined row ("Purchase/Upgrade of Machinery, Renovation of
  // Business") for what we show the customer as two separate options — both send the same code 27.
  'Purchase/Upgrade of Machinery': 27,
  'Renovation of Business': 27,
  Expansion: 26, // "Business Expansion"
  'Inventory purchase': 23, // "Purchase of Inventory"
};

/** `constitutionOfBusiness` values confirmed live from a real pantogstin response (2026-10-16,
 * PAN ABLCS1773K -> "Private Limited Company") -> our own BUSINESS_TYPES options. Only the values
 * we've actually seen or can confidently infer are mapped; anything else falls through to asking
 * the customer directly rather than guessing wrong. */
const CONSTITUTION_TO_BUSINESS_TYPE: Record<string, string> = {
  'Proprietorship': 'Proprietorship',
  'Partnership': 'Partnership',
  'Limited Liability Partnership': 'LLP',
  'Private Limited Company': 'Private limited',
  'Public Limited Company': 'Public limited',
  'One Person Company': 'OPC',
};

/** PAN's 4th character is the Income Tax Department's own entity-type code (partner-confirmed
 * table, 2026-10-16): P=Individual, C=Company, F=Firm/LLP, H=HUF, A=AOP, T=Trust, G=Government,
 * B=Body of Individuals, L=Local authority. 'individual' and 'partnership' map unambiguously (or
 * narrowly) onto our existing BUSINESS_TYPES/PROFESSION_TYPE_ID — 'company' is ambiguous between
 * Private/Public/OPC (the table's own fuller disambiguation needs a CIN/LLPIN lookup or the
 * registered business name, neither of which this flow has — narrowed to just those 3 choices
 * instead of guessing). Every other code has no BUSINESS_TYPES option or PROFESSION_TYPE_ID master
 * data at all yet — 'unsupported', same "don't have a journey for this yet" treatment as HL/LAP's
 * entity gate (see flows/homeLoan.ts's isIndividualPan). */
export type PanEntityCategory = 'individual' | 'partnership' | 'company' | 'unsupported' | 'unknown';

export function panEntityCategory(pan: string | undefined): PanEntityCategory {
  if (!pan || pan.length < 4) return 'unknown';
  switch (pan.charAt(3).toUpperCase()) {
    case 'P':
      return 'individual';
    case 'F':
      return 'partnership';
    case 'C':
      return 'company';
    case 'H':
    case 'A':
    case 'T':
    case 'G':
    case 'B':
    case 'L':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

export const BUSINESS_TYPE_OPTIONS_BY_CATEGORY: Partial<Record<PanEntityCategory, string[]>> = {
  partnership: ['Partnership', 'LLP'],
  company: ['Private limited', 'Public limited', 'OPC'],
};

/** Name-based disambiguation for the 'partnership'/'company' PAN categories, straight from the
 * partner's own rules (2026-10-17): "use name from PAN or GSTIN to identify exact" for F, "use
 * combination of GSTIN and Name" for C. We only ever have the GST-registered legal/trade name to
 * check against (no separate PAN-registered name lookup, no CIN/LLPIN), so this runs on
 * `businessName` (see PanToGstResult) whenever GST data found one. Returns undefined — not a
 * guess — when the name doesn't match anything recognized, so the caller still falls back to
 * asking the customer directly rather than defaulting to a possibly-wrong answer. */
export function disambiguateFromName(category: PanEntityCategory, businessName: string | undefined): string | undefined {
  if (!businessName) return undefined;
  const name = businessName.toLowerCase();

  if (category === 'partnership') {
    return /\bllp\b/.test(name) ? 'LLP' : 'Partnership';
  }

  if (category === 'company') {
    // Checked before the generic "limited"/"ltd" bucket below — "XYZ Private Limited" contains the
    // word "limited" too, and would otherwise be misclassified as Public.
    if (/\bone person\b/.test(name) || /\bopc\b/.test(name)) return 'OPC';
    if (/\bpvt\.?\s*ltd\.?\b/.test(name) || /\bprivate\s+limited\b/.test(name)) return 'Private limited';
    if (/\bpublic\s+limited\b/.test(name) || /\bpub\.?\s*ltd\.?\b/.test(name) || /\bpublic\s+ltd\.?\b/.test(name) || /\blimited\b/.test(name) || /\bltd\.?\b/.test(name)) {
      return 'Public limited';
    }
    return undefined;
  }

  return undefined;
}

export interface BusinessLoanLeadInput {
  conversationId: string;
  mobile: string;
  email: string;
  name?: string;
  creditScore?: number;
  remoteCustomerId?: number;
  /** The applicant's own (already-verified) personal PAN — used as the lead's panMasked record
   * even though the eventual business PAN may differ once collected; the lead itself doesn't need
   * to wait for that to exist, same as every other product's immediate-lead-creation pattern. */
  personalPan: string;
  token?: string;
}

export interface BusinessLoanLeadResult {
  leadId: string;
  rm: { name: string; phone: string; email: string };
}

export interface BusinessLoanDetailsInput {
  leadId: string;
  loanAmount: number;
  loanPurpose: string;
  businessPan: string;
  businessType: string;
  /** The real registered business name, when pantogstin found one — see PanToGstResult.
   * Falls back to the business PAN (the previous, placeholder behavior) only when GST data was
   * never found at all. */
  businessName?: string;
  gstNumber?: string;
  businessAddress: string;
  businessPincode: string;
  businessLandmark?: string;
  industry: string;
  incorporationDate: string;
  token?: string;
}

/** One GSTIN registration out of pantogstin's own gstListAdvanced. A single PAN can carry several
 * of these (one per state the entity is registered in) — the partner's spec (2026-10-17) says to
 * ask the customer which one is "primary" when there's more than one, rather than silently
 * assuming the first. */
export interface GstRegistration {
  gstin: string;
  /** legalNameOfBusiness, falling back to tradeName when that's blank/"NA" — confirmed live
   * (2026-10-16) both are present on each gstListAdvanced entry. */
  businessName?: string;
  constitutionOfBusiness?: string;
  /** administrativeOffice in the real response — the partner's spec calls this "Office Address". */
  officeAddress?: string;
  /** principalPlaceOfBusiness in the real response — the partner's spec calls this "Registered
   * Office Address"; a full postal address, usable in place of asking the customer to type their
   * business address manually. */
  registeredOfficeAddress?: string;
  /** The real response's own `state` field — confirmed live (2026-10-17), e.g. "Chattisgarh",
   * "Telangana". Used to label each GSTIN choice with its city/state when a PAN has several, so
   * the customer can tell them apart at a glance instead of just seeing bare GSTIN strings. */
  state?: string;
  /** effectiveDateOfRegistration in the real response, DD/MM/YYYY (e.g. "11/03/2025") — this is
   * when THIS GST registration took effect, not necessarily the entity's actual date of
   * incorporation (a company can incorporate well before registering for GST) — but it's the
   * closest real date pantogstin provides, and used in place of asking the customer directly
   * (2026-10-17 instruction). */
  gstRegistrationDate?: string;
}

export interface PanToGstResult {
  registrations: GstRegistration[];
}

export interface BusinessLoanService {
  /** Fired the moment the customer picks Business Loan — mirrors Personal Loan's "create the lead
   * immediately" pattern (2026-10-16 instruction) instead of waiting for the full profile, so a
   * real leadId exists early enough to back the PAN-to-GST lookup below. */
  createLead(input: BusinessLoanLeadInput): Promise<BusinessLoanLeadResult>;
  /** POST /leadflow/pantogstin — confirmed live and working (2026-10-16) against a real
   * GST-registered PAN, returning a full gstListAdvanced including constitutionOfBusiness. Used to
   * auto-detect GST registration/number and business entity type "on the basis of PAN" per the
   * original spec, instead of asking the customer both directly as this flow did before. Returns
   * null (not a throw) on a clean "not found"/error response — this is a nice-to-have shortcut, not
   * something that should ever block the flow; the manual questions are always the fallback. */
  fetchGstFromPan(leadId: string, pan: string, token?: string): Promise<PanToGstResult | null>;
  /** POST /leadflow/businessloandtl — saves the full collected profile onto the lead created by
   * createLead() above, once the rest of the conversation has gathered it. */
  saveDetails(input: BusinessLoanDetailsInput): Promise<void>;
}

class MockBusinessLoanService implements BusinessLoanService {
  async createLead(input: BusinessLoanLeadInput): Promise<BusinessLoanLeadResult> {
    const seedKey = input.mobile || input.personalPan;
    return { leadId: generateLeadId(), rm: pickRm(seedKey) };
  }

  async fetchGstFromPan(): Promise<PanToGstResult | null> {
    return null; // no mock GST data — keeps the manual-ask fallback path exercised in dev
  }

  async saveDetails(): Promise<void> {
    // no-op, same "nothing real to save without a configured API" spirit as every other mock
  }
}

// finfinityClient.post() already unwraps the outer {data, error_msg, ...} envelope and resolves
// with envelope.data directly — this type is that already-unwrapped array, NOT a second nested
// `.data` wrapper (that was the actual bug here, 2026-10-17: `result.data?.[0]` on an array that
// has no `.data` property silently resolved to undefined every time, even on a real HTTP success).
type PanToGstinResponse = Array<{
  response: {
    code: number | string;
    gstListAdvanced?: Array<{
      gstin?: string;
      constitutionOfBusiness?: string;
      legalNameOfBusiness?: string;
      tradeName?: string;
      administrativeOffice?: string;
      principalPlaceOfBusiness?: string;
      state?: string;
      effectiveDateOfRegistration?: string;
      [key: string]: unknown;
    }>;
  };
}>;

/** Real API — confirmed live against UAT:
 * 1. POST /leadflow/create_anacity_lead (product_code 'BL', 2026-10-16 — switched from
 *    createcorplead, which never returned an RM; this one does, same as HL/LAP/LAS/GL) creates the
 *    lead, now fired immediately rather than deferred to the end (2026-10-16 instruction).
 * 2. POST /leadflow/pantogstin looks up GST registration + entity type from a PAN.
 * 3. POST /leadflow/businessloandtl saves the business/entity details onto the lead.
 *
 * Unlike Gold Loan, businessloandtl doesn't select a specific LENDER (no lender_name field), so
 * the "one lead per lender" constraint discovered there doesn't apply here — safe to create the
 * lead up front and fill in details later.
 */
class RealBusinessLoanService implements BusinessLoanService {
  async createLead(input: BusinessLoanLeadInput): Promise<BusinessLoanLeadResult> {
    const lead = await ensureLeadOnce({
      conversationId: input.conversationId,
      rawPan: input.personalPan,
      panMasked: maskPan(input.personalPan),
      name: input.name,
      mobileMasked: input.mobile,
      creditScore: input.creditScore,
      product: 'Business Loan',
      loanType: 'Business Loan',
      remoteCustomerId: input.remoteCustomerId,
      token: input.token,
    });
    if (!lead.builderLeadId) throw new Error('create_anacity_lead returned no lead id');
    const seedKey = input.mobile || input.personalPan;
    return { leadId: lead.builderLeadId, rm: lead.rm ?? pickRm(seedKey) };
  }

  async fetchGstFromPan(leadId: string, pan: string, token?: string): Promise<PanToGstResult | null> {
    try {
      // retryOnTransient defaults to true — this is a pure lookup, safe to retry on a blip.
      const result = await finfinityClient.post<PanToGstinResponse>(
        '/leadflow/pantogstin',
        { applicationId: Number(leadId), panNumber: pan },
        { token },
      );
      const gstList = result[0]?.response?.gstListAdvanced;
      if (!gstList?.length) return null;
      // Confirmed live: the same business can come back with inconsistent casing, or "NA", across
      // its different state registrations — take the first usable one per entry rather than
      // assuming index 0 always has every field populated.
      const usable = (v: string | undefined) => (v && v !== 'NA' ? v : undefined);
      const registrations: GstRegistration[] = gstList
        .filter((g): g is typeof g & { gstin: string } => Boolean(g.gstin))
        .map((g) => ({
          gstin: g.gstin,
          businessName: usable(g.legalNameOfBusiness) ?? usable(g.tradeName),
          constitutionOfBusiness: g.constitutionOfBusiness,
          officeAddress: usable(g.administrativeOffice),
          registeredOfficeAddress: usable(g.principalPlaceOfBusiness),
          state: usable(g.state),
          gstRegistrationDate: usable(g.effectiveDateOfRegistration),
        }));
      if (registrations.length === 0) return null;
      return { registrations };
    } catch (err) {
      // Was a completely silent catch — a failure here (expired token, a real pantogstin outage,
      // anything) vanished with zero trace anywhere, making a customer-reported "it didn't find my
      // GST" impossible to actually diagnose after the fact (2026-10-17). Still fails OPEN (falls
      // back to asking the customer directly) since this is a nice-to-have shortcut, not a hard
      // requirement — just no longer invisible when it does.
      const code = err instanceof FinfinityApiError ? err.code : undefined;
      const detail = err instanceof FinfinityApiError ? err.detail : err instanceof Error ? err.message : err;
      logger.warn({ event: 'pantogstin_lookup_failed', leadId, panMasked: maskPan(pan), code, detail }, 'PAN-to-GST lookup failed — falling back to asking the customer directly');
      return null;
    }
  }

  async saveDetails(input: BusinessLoanDetailsInput): Promise<void> {
    const natureId = NATURE_OF_BUSINESS_ID[input.industry];
    const constitutionId = CONSTITUTION_TYPE_ID[input.businessType];
    const purposeId = LOAN_PURPOSE_ID[input.loanPurpose];
    if (natureId === undefined || constitutionId === undefined || purposeId === undefined) {
      throw new Error(`businessLoan.service: no master-ID mapping for industry="${input.industry}" businessType="${input.businessType}" loanPurpose="${input.loanPurpose}"`);
    }

    await finfinityClient.post(
      '/leadflow/businessloandtl',
      {
        leadId: Number(input.leadId),
        // Real registered name when pantogstin found one (2026-10-16) — falls back to the business
        // PAN itself only when no GST data exists to get a real name from.
        business_name: input.businessName ?? input.businessPan,
        business_name_flag: true,
        gstin: input.gstNumber ?? '',
        nature_of_business: natureId,
        constitution_type: constitutionId,
        business_vintage: '', // derived from incorporationDate by the backend if needed — not separately collected as a plain number
        date_of_incorporation: input.incorporationDate,
        business_addr1: input.businessAddress,
        // Security-review finding, 2026-10-23: businessPincode was already being collected and
        // passed into this function, but never actually forwarded in the request body — and
        // businessLandmark wasn't being collected into this input at all. Field names here
        // (business_pincode/business_addr2) follow this same payload's own business_addr1
        // convention but aren't independently confirmed against a live businessloandtl call the way
        // other fields in this file are (see this file's other "confirmed live" comments) —
        // worth verifying against UAT before relying on Finfinity actually using them.
        business_pincode: input.businessPincode,
        business_addr2: input.businessLandmark ?? '',
        udyog_registration_no: '', // not collected in this flow
        loan_purpose: purposeId,
        requested_loan_amount: String(input.loanAmount),
      },
      { token: input.token, retryOnTransient: false },
    );
  }
}

export const businessLoanService: BusinessLoanService = env.FINFINITY_API_BASE_URL ? new RealBusinessLoanService() : new MockBusinessLoanService();
export { CONSTITUTION_TO_BUSINESS_TYPE };
