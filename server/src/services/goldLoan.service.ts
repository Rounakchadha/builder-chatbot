import { env } from '../config/env';
import { logger } from '../lib/logger';
import { finfinityClient, FinfinityApiError } from './finfinityClient';

// Real endpoints (partner-provided doc, 2026-10-15) titled "Gold loan Lead API for Mannapuram" but
// the actual field values/function names are Muthoot-specific (`MUTHOOT GOLD`,
// `muthootleadgeneration`) — a naming inconsistency in the source doc, not ours; followed as given.
const LENDER_NAME = 'MUTHOOT GOLD';

export interface GoldSubmitInput {
  /** The real Finfinity lead id — created much earlier now (see flows/goldLoan.ts's glCreateLead),
   * the moment the customer entered this branch, same as every other product. Only the
   * Muthoot-specific attach+submit below is still deferred to this explicit click (2026-10-21
   * instruction: "we already get the rm before we click the muthoot loan" — a generic
   * create_anacity_lead doesn't consume the "one Muthoot lead per customer" slot, only
   * setmuthootlenderoffer/muthootleadgeneration do, so there was never a reason to defer the lead
   * itself, only these two calls). */
  leadId: string;
  rm: { name: string; phone: string; email: string };
  token?: string;
}

export interface GoldSubmitResult {
  ok: boolean;
  /** Set when Finfinity's real "one Muthoot lead per customer" rule already blocks this customer —
   * a genuine, expected state (a real repeat customer), not a failure. */
  alreadyExists?: boolean;
  message?: string;
  leadId?: string;
  rm?: { name: string; phone: string; email: string };
}

export interface GoldLeadService {
  /** Attaches Muthoot as the lender and submits — fired ONLY when the customer taps the submit card
   * (2026-10-15 redesign: these two specific calls permanently consume Finfinity's "one Muthoot
   * lead per customer" slot, so nothing here runs before explicit customer action). The lead itself
   * already exists by this point (glCreateLead, run the moment the customer entered this branch). */
  submitApplication(input: GoldSubmitInput): Promise<GoldSubmitResult>;
}

class MockGoldLeadService implements GoldLeadService {
  async submitApplication(input: GoldSubmitInput): Promise<GoldSubmitResult> {
    return { ok: true, leadId: input.leadId, rm: input.rm };
  }
}

/** Real API — confirmed live against UAT:
 * 1. POST /leadflow/create_anacity_lead (product_code 'GL') creates the lead — now fired early (see
 *    flows/goldLoan.ts's glCreateLead), not here.
 * 2. POST /leadflow/setmuthootlenderoffer attaches Muthoot as the chosen lender.
 * 3. POST /leadflow/muthootleadgeneration is the real submission to Muthoot.
 *
 * Only 2 and 3 fire on submit now (see GoldLeadService's doc comment above for why). Finfinity
 * enforces one Muthoot gold-loan lead per customer at a time (confirmed live: error_code
 * FRM_LENDER_EXHAUSTED / "Lead Already Exist") — handled as a real, expected state below, not a crash.
 */
class RealGoldLeadService implements GoldLeadService {
  async submitApplication(input: GoldSubmitInput): Promise<GoldSubmitResult> {
    const { leadId, rm, token } = input;

    try {
      await finfinityClient.post('/leadflow/setmuthootlenderoffer', { leadid: Number(leadId), lender_name: LENDER_NAME }, { token, retryOnTransient: false });
    } catch (err) {
      if (err instanceof FinfinityApiError && err.code === 'FRM_LENDER_EXHAUSTED') {
        // Security-review finding, 2026-10-23: FRM_LENDER_EXHAUSTED here only means "Muthoot is
        // already attached as this lead's lender" — that can genuinely happen from a PRIOR
        // successful submission, but it can just as easily be our OWN earlier attempt that attached
        // the lender here and then failed on muthootleadgeneration below (a transient error, a
        // timeout, anything other than "already submitted"). Returning "you already have an active
        // application" immediately used to tell the customer a real submission existed even when
        // one never actually completed, with no way for them to retry and no real application on
        // file either. The lender being attached doesn't block muthootleadgeneration itself, so fall
        // through and try it anyway — if a submission genuinely already went through, that call's
        // own "already exists" handling below reports it accurately; if it didn't, this retry is
        // what actually completes the stalled submission.
        logger.info({ event: 'gold_lender_already_attached', leadId }, 'Muthoot already attached to this lead — attempting submission anyway in case an earlier attempt never completed it');
      } else {
        throw err;
      }
    }

    try {
      // retryOnTransient: false — non-idempotent (a real submission to Muthoot).
      await finfinityClient.post('/leadflow/muthootleadgeneration', { leadid: Number(leadId) }, { token, retryOnTransient: false });
      return { ok: true, leadId, rm };
    } catch (err) {
      if (err instanceof FinfinityApiError && (err.code === '208' || /already exist/i.test(err.message))) {
        return { ok: false, alreadyExists: true, leadId, rm, message: 'This application has already been submitted to Muthoot.' };
      }
      // Confirmed live (2026-10-21): this endpoint sometimes puts its SUCCESS response in the
      // error envelope shape — error_code "200" with error_msg "Lead Created Successfully" — which
      // finfinityClient.ts's generic "any error_code is a failure" rule misreads as a real error.
      // Not safe to allowlist "200" globally in finfinityClient (too generic a code to assume it
      // always means success everywhere), so it's handled narrowly here instead, specific to this
      // one endpoint's own confirmed quirk. Without this, every genuinely successful Muthoot
      // submission was reported to the customer as "couldn't submit" and skipped the RM email too.
      if (err instanceof FinfinityApiError && err.code === '200' && /created successfully/i.test(err.message)) {
        return { ok: true, leadId, rm };
      }
      logger.error({ err, event: 'gold_submit_failed', leadId }, 'muthootleadgeneration failed');
      return { ok: false, leadId, rm, message: "Couldn't submit this application right now — please try again shortly." };
    }
  }
}

export const goldLeadService: GoldLeadService = env.FINFINITY_API_BASE_URL ? new RealGoldLeadService() : new MockGoldLeadService();
