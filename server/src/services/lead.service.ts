import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { encryptPii } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
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
  /** True when this call found and reused an existing lead instead of creating a new one — see
   * ensureLeadOnce. updateLead/updateCustomer appear to trigger Finfinity's own lead notification
   * every time they run — confirmed 2026-10-31 by 5 "Start over" conversations for the same
   * returning customer correctly reusing the same real builderLeadId (lead creation itself was NOT
   * duplicated), yet the email spam to Sparsh continued anyway. Callers should still sync on a
   * reused lead when the financials actually changed (see lastSyncedFinancialsJson below) — only a
   * byte-for-byte-identical revisit should skip it entirely. */
  reused?: boolean;
  /** Whatever was last successfully synced onto this lead (see Lead.lastSyncedFinancialsJson's own
   * comment in schema.prisma) — undefined on a genuinely new lead (nothing synced yet), so callers
   * naturally always sync the first time. */
  lastSyncedFinancialsJson?: string | null;
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
  /** Records the customer's chosen tenure for whichever offer they picked — POST
   * /leadflow/setbrefinanceroffertenure, confirmed live (2026-10-15) to work identically across
   * Home Loan, LAP, and Personal Loan leads (same payload shape, no product-specific quirks). */
  setOfferTenure(leadId: string, tenureMonths: number, token?: string): Promise<void>;
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

  async setOfferTenure(): Promise<void> {
    logger.info({ event: 'lead_set_offer_tenure_mock' }, 'mock offer-tenure select (no-op — nothing real to sync)');
  }
}

/** Only "fresh" is a confirmed real value (from Ritendra's example payload) — the rest (balance
 * transfer, LAP-specific) are a best-effort guess pending confirmation of the real enum. */
function mapLoanType(loanType: string): string {
  // Was 'balance_transfer' — confirmed live (2026-10-21) that updatelead rejects it outright for
  // BOTH Home Loan and LAP ("Loan type 'Balance Transfer' is not valid for product HL/LAP"),
  // meaning every Balance Transfer customer's income/EMI silently never reached the real lead.
  // 'loan_takeover' is the real value (partner-confirmed, re-verified live on fresh HL and LAP
  // leads 76137/76138 — "Lead Updated Successfully" both times). A 'bt+topup' value also exists
  // and was verified working too, but isn't wired in — no top-up option exists anywhere in this
  // flow for the customer to actually choose it (2026-10-21 instruction: "topup is not an option").
  if (loanType.includes('Balance transfer')) return 'loan_takeover';
  if (loanType === 'Loan Against Property (LAP)') return 'lap';
  return 'fresh'; // 'Fresh purchase' or 'Property purchase'
}

/** Our display strings -> the real backend's product codes for create_anacity_lead. 'GL'/'PL'/'BL'
 * confirmed live against UAT (2026-10-16) — same call, same real RM-in-response behavior as HL/LAP,
 * now the MAIN lead-creation path for every product (superseding createcorplead, which never
 * returned an RM — see goldLoan.service.ts/businessLoan.service.ts, now updated to use this too). */
export const PRODUCT_CODE: Record<string, string> = {
  'Home loan': 'HL',
  'Loan Against Property': 'LAP',
  'Loan Against Securities': 'LAS',
  'Gold Loan': 'GL',
  'Personal Loan': 'PL',
  'Business Loan': 'BL',
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
    // seller_type/completion_status/carpet_area/resale_flag are collected for Finfinity's record-
    // keeping only — never asked of the customer, never shown to them, and not used in our own
    // eligibility math. Per Ritendra: "builder" for seller_type when a property's actually been
    // identified (even though "individual" is a valid option) — but blank when it hasn't, since
    // there's no seller at all yet to describe (2026-10-16 direct instruction). A fixed carpet_area
    // of 1000, and resale_flag: false (never a resale). completion_status is "completed" unless the
    // chosen property/collateral is a plot, in which case it's "yet_to_start" (a plot has nothing
    // built yet). resale_flag doesn't come back in updatelead's own response either way (confirmed
    // live, 2026-10-08 — identical response whether sent true/false/"Yes"/1/omitted/a bogus field
    // name), but a real lead (75305) was confirmed changed on Finfinity's own internal side after
    // sending it, so it is a real field.
    const isPlot = /plot/i.test(financials.propertyType ?? '') || /plot/i.test(financials.collateralType ?? '');

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
        // Was a plain .toLowerCase() with no separator normalization, unlike occupancy_type right
        // above it — broke any multi-word option (e.g. "School/College" -> "school/college",
        // "Nursing Home" -> "nursing home") and was confirmed live (2026-10-16) to get "APMC"
        // rejected outright as "Invalid collateral type" even single-worded. Normalizing to match
        // occupancy_type's pattern fixes the multi-word cases; APMC's rejection is a separate,
        // already-flagged issue (its own value may simply not be in their accepted list at all).
        collateral_type: financials.collateralType?.toLowerCase().replace(/[^a-z]+/g, '_'),
        property_value: financials.propertyValue,
        seller_type: financials.propertyIdentified ? 'builder' : '',
        completion_status: isPlot ? 'yet_to_start' : 'completed',
        carpet_area: '1000',
        resale_flag: false,
      },
      { token },
    );
  }

  async setOfferTenure(leadId: string, tenureMonths: number, token?: string): Promise<void> {
    // retryOnTransient defaults to true (safe — this just records a choice, not a creation) — no
    // override needed, unlike the non-idempotent lead-creation calls above.
    await finfinityClient.post(
      '/leadflow/setbrefinanceroffertenure',
      { leadid: Number(leadId), hasMultipleTenure: 'N', tenure: String(tenureMonths) },
      { token },
    );
  }

}

export const leadService: LeadService = env.FINFINITY_API_BASE_URL ? new RealLeadService() : new MockLeadService();

export interface EnsureLeadInput extends LeadProfile {
  /** Raw PAN (never logged/persisted anywhere unencrypted) — only needed here to populate the
   * local Lead row's panEncrypted, same as homeLoan.ts's old inline ensureLead used to do. */
  rawPan: string;
}

/**
 * The ONE place every flow (Home Loan, Personal Loan, Gold Loan, Loan Against Securities —
 * Business Loan has its own parallel version in businessLoan.service.ts, same idea) should go
 * through to create a real lead, instead of calling leadService.createLead() directly.
 *
 * Bug fixed 2026-10-31: every flow's own create-lead step only ever checked "does a Lead already
 * exist for THIS conversation" (Lead.conversationId is unique) — correct for stopping a double-
 * click/retry within one session, but it does nothing for a RETURNING real customer: "Start over",
 * a reload, or just reopening the widget starts a brand-new Conversation row, which has never seen
 * a Lead before, so every flow called create_anacity_lead again — a second real lead, a second real
 * RM assignment, and a second email to Sparsh, for a person who already has one. User's own words:
 * "ek bande ki ek bank ki ek product ki ek hi lead honi chaiye" (one lead per person per product).
 *
 * Fix: also check for a prior Lead belonging to the SAME real customer (remoteCustomerId — the
 * Finfinity backend's own customer_id, stable across every conversation for the same person, unlike
 * the local mock-only Customer.id) for the SAME product (every product shares one Conversation.
 * flowId, so flowId alone can't distinguish them — see Lead.product in schema.prisma). If one's
 * found, reuse its builderLeadId instead of calling the real API again, while still recording a
 * local Lead row for THIS conversation (status-check/profile-sync code looks leads up by
 * conversationId, so this new conversation needs its own row pointing at the same real lead).
 */
/** Reconstructs the RM shape LeadSyncResult.rm expects from a stored Lead row's rmName/rmPhone/
 * rmEmail — undefined (not a partially-empty object) unless all three are present, so callers'
 * existing `lead?.rm ?? { name: 'Our team', ... }` fallback keeps working unchanged for any lead
 * created before this migration existed. */
function rmFromRow(row: { rmName: string | null; rmPhone: string | null; rmEmail: string | null }): LeadSyncResult['rm'] {
  if (!row.rmName || !row.rmPhone || !row.rmEmail) return undefined;
  return { name: row.rmName, phone: row.rmPhone, email: row.rmEmail };
}

export async function ensureLeadOnce(input: EnsureLeadInput): Promise<LeadSyncResult> {
  // 1. Already created for THIS exact conversation? (same guard homeLoan.ts's old ensureLead had —
  // a double-click or a retried request after a network blip shouldn't create a second real lead.)
  const existingHere = await prisma.lead.findUnique({ where: { conversationId: input.conversationId } });
  if (existingHere) {
    return {
      builderLeadId: existingHere.builderLeadId,
      status: existingHere.builderSyncStatus as LeadSyncResult['status'],
      reused: true,
      rm: rmFromRow(existingHere),
      lastSyncedFinancialsJson: existingHere.lastSyncedFinancialsJson,
    };
  }

  const leadRowData = (builderLeadId: string | null, builderSyncStatus: LeadSyncResult['status'], rm?: LeadSyncResult['rm']): Prisma.LeadUncheckedCreateInput => ({
    conversationId: input.conversationId,
    remoteCustomerId: input.remoteCustomerId ?? null,
    product: input.product,
    panEncrypted: encryptPii(input.rawPan),
    panMasked: input.panMasked,
    nameEncrypted: input.name ? encryptPii(input.name) : null,
    creditScore: input.creditScore ?? null,
    builderLeadId,
    builderSyncStatus,
    rmName: rm?.name ?? null,
    rmPhone: rm?.phone ?? null,
    rmEmail: rm?.email ?? null,
  });

  // 2. A prior lead for the SAME real customer + product, from a DIFFERENT conversation? Only
  // meaningful once we have a real remoteCustomerId (mock mode has none — no cross-session identity
  // to dedupe against there, which is fine, mock mode was never the real duplicate-email problem).
  if (input.remoteCustomerId !== undefined) {
    const prior = await prisma.lead.findFirst({
      where: { remoteCustomerId: input.remoteCustomerId, product: input.product, builderLeadId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (prior?.builderLeadId) {
      const rm = rmFromRow(prior);
      try {
        await prisma.lead.create({ data: leadRowData(prior.builderLeadId, 'synced', rm) });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
      logger.info(
        { event: 'lead_reused_existing', conversationId: input.conversationId, remoteCustomerId: input.remoteCustomerId, product: input.product, builderLeadId: prior.builderLeadId },
        'reusing an already-created real lead for this customer+product instead of creating a duplicate',
      );
      // Same original RM every time a returning customer's lead is reused — never a placeholder,
      // never a freshly reassigned one (explicit instruction, 2026-11-13).
      return { builderLeadId: prior.builderLeadId, status: 'synced', reused: true, rm, lastSyncedFinancialsJson: prior.lastSyncedFinancialsJson };
    }
  }

  // 3. Genuinely new — create for real, same race-recovery as before (P2002 = a true concurrent
  // second request for this same conversation won the insert a moment ago).
  const result = await leadService.createLead(input);
  try {
    await prisma.lead.create({ data: leadRowData(result.builderLeadId, result.status, result.rm) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.lead.findUnique({ where: { conversationId: input.conversationId } });
      return { builderLeadId: winner?.builderLeadId ?? result.builderLeadId, status: 'synced', rm: winner ? rmFromRow(winner) : result.rm, lastSyncedFinancialsJson: winner?.lastSyncedFinancialsJson };
    }
    throw err;
  }
  return result;
}

/** Records what was just successfully pushed onto this lead (see homeLoan.ts's ensureLead, the
 * only caller) so the NEXT time this lead gets reused — same conversation or a fresh one — we know
 * whether anything has actually changed since, instead of either always skipping the sync (the
 * 2026-11-10 staleness bug) or always running it (the original 2026-10-31 RM-email-spam problem). */
export async function markLeadFinancialsSynced(conversationId: string, snapshotJson: string): Promise<void> {
  await prisma.lead.update({ where: { conversationId }, data: { lastSyncedFinancialsJson: snapshotJson } });
}

/** Has the RM-summary email already gone out for this exact customer+product, in ANY conversation?
 * See Lead.rmEmailSent's own doc comment in schema.prisma for the bug this fixes — checked by
 * routes/chat.ts BEFORE calling emailService.sendRmSummary, not just ctx.answers' own per-
 * conversation flag. Mock mode (no remoteCustomerId) has no cross-conversation identity to check
 * against, same as ensureLeadOnce's own lead-reuse dedupe — always false there. */
export async function hasRmSummaryEmailAlreadySent(remoteCustomerId: number | undefined, product: string): Promise<boolean> {
  if (remoteCustomerId === undefined) return false;
  const prior = await prisma.lead.findFirst({ where: { remoteCustomerId, product, rmEmailSent: true } });
  return Boolean(prior);
}

/** Marks THIS conversation's own Lead row as having sent the RM-summary email — called once
 * emailService.sendRmSummary actually reports success. A later conversation reusing the same real
 * lead will find this via hasRmSummaryEmailAlreadySent regardless of which conversation's row it's
 * actually stored on, since that query matches on remoteCustomerId+product, not conversationId. */
export async function markRmSummaryEmailSent(conversationId: string): Promise<void> {
  await prisma.lead.update({ where: { conversationId }, data: { rmEmailSent: true } });
}
