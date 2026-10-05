import { env } from '../config/env';
import { logger } from '../lib/logger';
import { finfinityClient } from './finfinityClient';

export interface LeadProfile {
  conversationId: string;
  panMasked: string;
  name?: string;
  mobileMasked?: string;
  creditScore?: number;
  product: string;
  loanType: string;
  /** The real backend's own integer customer id — required by create_anacity_lead. Absent when
   * we've only ever created a local mock Customer row (no real backend configured yet). */
  remoteCustomerId?: number;
  /** The most recent access token captured this conversation (from OTP #1, or OTP #2/bureau if
   * that's happened) — required by the real service. */
  token?: string;
}

export interface LeadSyncResult {
  builderLeadId: string | null;
  status: 'synced' | 'failed' | 'pending';
  /** The real relationship manager Finfinity actually assigned to this lead — returned right in
   * create_anacity_lead's own response. Only ever set by the real service; the mock leaves this
   * undefined so the flow's placeholder RM (see flows/rm.ts's pickRm) still applies there. */
  rm?: { name: string; phone: string; email: string };
}

/** Everything updatelead accepts — the fields getcustomeroffers actually needs to compute a real
 * eligibility number, which create_anacity_lead alone never captures. */
export interface LeadFinancials {
  loanType: string; // our display string, e.g. "Fresh purchase" — mapped below
  income: number;
  emi: number;
  propertyIdentified: boolean;
  propertyType?: string;
  occupancy?: string;
  collateralType?: string;
  propertyValue?: number;
}

export interface LeadService {
  createLead(profile: LeadProfile): Promise<LeadSyncResult>;
  /** Syncs income/EMI/property details onto an already-created lead. `token` is the most recent
   * access token captured this conversation. */
  updateLead(leadId: string, financials: LeadFinancials, token?: string): Promise<void>;
}

/**
 * Stubbed until the Builder module's lead-creation API docs/credentials are
 * shared. Called exactly once per conversation, only when panConsent=true
 * and the CIBIL pull succeeded (enforced by the route, not here).
 */
class MockLeadService implements LeadService {
  async createLead(profile: LeadProfile): Promise<LeadSyncResult> {
    logger.info({ event: 'lead_create_mock', conversationId: profile.conversationId, product: profile.product }, 'mock lead created (Builder module not yet wired)');
    return { builderLeadId: `MOCK-${profile.conversationId.slice(0, 8)}`, status: 'pending' };
  }

  async updateLead(): Promise<void> {
    logger.info({ event: 'lead_update_mock' }, 'mock lead update (no-op — nothing real to sync)');
  }
}

/** Only "fresh" is a confirmed real value (from Ritendra's example payload) — the rest (balance
 * transfer, LAP-specific) are a best-effort guess pending confirmation of the real enum. */
function mapLoanType(loanType: string): string {
  if (loanType.includes('Balance transfer')) return 'balance_transfer';
  if (loanType === 'Loan against property (LAP)') return 'lap';
  return 'fresh'; // 'Fresh purchase' or 'Property purchase'
}

/** Our "Home loan" / "Loan against property" display strings -> the real backend's product codes. */
export const PRODUCT_CODE: Record<string, string> = {
  'Home loan': 'HL',
  'Loan against property': 'LAP',
};

// Confirmed live against UAT (2026-09-23): "FINFINITY" (the docs' example value) is not a real
// registered campaign and crashed create_anacity_lead with an internal server error every time
// ("Error processing UTM params" / "object of type 'NoneType' has no len()") — "anacity" (matching
// the endpoint's own name) is a real one and works. Ask the dev team for the actual production
// campaign code once one exists; this is a UAT-testing value.
const CAMPAIGN_CODE = 'anacity';

interface CreateLeadResponse {
  leadid: number;
  customer_id: number;
  product_code: string;
  // Confirmed live (2026-09-29): create_anacity_lead assigns a real relationship manager right
  // away and hands their details back in this same response.
  rm_name?: string;
  rm_email?: string;
  rm_mobile_number?: string;
}

/** Real Lead-creation API — POST /leadflow/create_anacity_lead. Needs the real backend's own
 * customer_id, which only exists once a customer has actually gone through searchcustomer (found)
 * or validateotpv2 (not-found) against the real backend — see dedupe.service.ts/sms.service.ts. */
class RealLeadService implements LeadService {
  async createLead(profile: LeadProfile): Promise<LeadSyncResult> {
    if (profile.remoteCustomerId === undefined) {
      throw new Error('createLead: no remoteCustomerId on this conversation — the real backend needs one from searchcustomer or validateotpv2 first');
    }
    const productCode = PRODUCT_CODE[profile.product];
    if (!productCode) throw new Error(`createLead: no product_code mapping for "${profile.product}"`);

    // retryOnTransient: false — this creates a brand-new lead every call; retrying blind after a
    // timeout risks creating a second real lead if the first request actually landed.
    const results = await finfinityClient.post<CreateLeadResponse[]>(
      '/leadflow/create_anacity_lead',
      {
        customer_id: profile.remoteCustomerId,
        product_code: productCode,
        campaign_code: CAMPAIGN_CODE,
      },
      { token: profile.token, retryOnTransient: false },
    );
    const lead = results[0];
    if (!lead) throw new Error('create_anacity_lead returned no data');

    // Raw 10-digit, no country code or spacing — formatted to match the same "+91 XXXXX XXXXX"
    // style the placeholder RM list already used, so a real RM doesn't look inconsistent.
    const rmPhone = lead.rm_mobile_number && /^\d{10}$/.test(lead.rm_mobile_number)
      ? `+91 ${lead.rm_mobile_number.slice(0, 5)} ${lead.rm_mobile_number.slice(5)}`
      : lead.rm_mobile_number;
    const rm = lead.rm_name && lead.rm_email && rmPhone ? { name: lead.rm_name, email: lead.rm_email, phone: rmPhone } : undefined;
    return { builderLeadId: String(lead.leadid), status: 'synced', rm };
  }

  /** Real API — POST /leadflow/updatelead. Their example shows occupancy_type/collateral_type as
   * plain lowercased versions of the same option names we already show the customer (e.g. our
   * "Apartment/Flat" -> their "apartment/flat") — applying that pattern to property_type too, since
   * it wasn't shown non-blank in their example. */
  async updateLead(leadId: string, financials: LeadFinancials, token?: string): Promise<void> {
    await finfinityClient.post(
      '/leadflow/updatelead',
      {
        leadid: Number(leadId),
        loan_type: mapLoanType(financials.loanType),
        monthly_income: financials.income,
        bonus_income: 0, // not collected in chat
        rental_income: 0, // not collected in chat
        existing_emi: financials.emi,
        property_identified: financials.propertyIdentified ? 'Yes' : 'No',
        property_type: financials.propertyType?.toLowerCase() ?? '',
        occupancy_type: financials.occupancy?.toLowerCase().replace(/[^a-z]+/g, '_'),
        collateral_type: financials.collateralType?.toLowerCase(),
        property_value: financials.propertyValue,
      },
      { token },
    );
  }
}

export const leadService: LeadService = env.FINFINITY_API_BASE_URL ? new RealLeadService() : new MockLeadService();
