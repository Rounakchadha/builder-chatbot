import { createHmac, randomUUID } from 'crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { pincodeService } from './pincode.service';

const REQUEST_TIMEOUT_MS = 10_000;

// CIS's own product label, where it differs from ours (2026-11-05 proposal from Sai — "Loan Against
// Securities", not our internal "Loan Against Shares"). Anything not listed here is sent as-is.
const PRODUCT_LABEL_MAP: Record<string, string> = {
  'Loan Against Shares': 'Loan Against Securities',
};

// Agreed with Sai (CIS, 2026-11-16 WhatsApp) — CIS wants a "Client type" field for their CRM with
// options Business Promoter/Salaried/Professional/NRI/Others, but we only ever collect `segment`
// (Salaried/Business owner/Self-employed professional — the valid flags our own APIs use; NRI/
// Others are never asked and never will be). Resolution: map our existing segment onto CIS's own
// labels here, rather than adding a new question neither side actually needs. Sent as `client_type`
// in the payload below — told to Sai 2026-11-17, his team updates their webhook handler for it.
const CLIENT_TYPE_MAP: Record<string, string> = {
  'Business owner': 'Business Promoter',
  Salaried: 'Salaried',
  'Self-employed professional': 'Professional',
};

export interface LeadCreatedWebhookInput {
  leadId: string;
  name?: string;
  mobile?: string;
  email?: string;
  pan?: string;
  product: string;
  loanType: string;
  /** Best-effort — undefined when the lead is created before this is asked (e.g. Business Loan and
   * Gold Loan create their lead the moment the product is picked, before amount/turnover is asked).
   * Sent as 0 in that case rather than blocking the webhook on data that isn't collected yet. */
  loanAmount?: number;
  segment?: string;
  /** Monthly, in rupees. Business Loan has no direct "monthly income" ask — annual profit / 12 is
   * passed in by the caller (flows/businessLoan.ts). Gold Loan and Loan Against Shares collect
   * neither income nor profit at all — 0, per explicit instruction (2026-11-06). */
  monthlyIncome?: number;
  pincode?: string;
  city?: string;
}

/** POSTs a LEAD_CREATED event to CIS's CRM webhook (UAT URL/secret/token from Sai, 2026-11-05).
 * Fire-and-forget from the caller's point of view — see lead.service.ts's ensureLeadOnce, which
 * calls this without awaiting and only once, right after a genuinely NEW real lead is created
 * (never on a reused lead, same "don't re-notify" principle as the RM-summary-email dedupe). A
 * failure here must never affect the customer's own journey, so this only ever logs, never throws.
 *
 * No-op when CIS_WEBHOOK_URL is unset — same pattern as every other optional integration in this
 * codebase (see EXTERNAL_SDK_SECRET/SANDBOX_TEST_PAN in config/env.ts).
 */
export async function sendLeadCreatedWebhook(input: LeadCreatedWebhookInput): Promise<void> {
  if (!env.CIS_WEBHOOK_URL) return;

  // Bug fixed 2026-11-13: `city` only ever came from ctx.answers.pincodeArea, which is set
  // EXCLUSIVELY by the interactive 'pincode' step's own onAnswer (pincodeService.lookupArea) — a
  // customer dedupeCheck already FOUND never goes through that step at all (their pincode comes
  // straight from searchcustomer instead), so city was always sent as an empty string for them.
  // Confirmed live: CIS's webhook rejects that outright with a 422 ("city: String should have at
  // least 1 character"), silently losing the whole lead notification for every found customer.
  // Deriving it fresh here, from whatever pincode IS known, covers that gap for every product at
  // once rather than each flow's own call site needing to remember to do this itself.
  let city = input.city;
  if (!city && input.pincode) {
    city = (await pincodeService.lookupArea(input.pincode).catch(() => null)) ?? undefined;
  }

  const body = {
    event_type: 'LEAD_CREATED',
    event_id: `FIN-EVT-${randomUUID()}`,
    event_timestamp: new Date().toISOString(),
    finfinity_lead_id: input.leadId,
    name: input.name ?? '',
    mobile: input.mobile ?? '',
    email: input.email ?? '',
    product: PRODUCT_LABEL_MAP[input.product] ?? input.product,
    loan_type: input.loanType,
    requested_amount: input.loanAmount ?? 0,
    employment_type: input.segment ?? '',
    client_type: (input.segment && CLIENT_TYPE_MAP[input.segment]) ?? '',
    monthly_income: input.monthlyIncome ?? 0,
    city: city ?? '',
    pincode: input.pincode ?? '',
    status: 'LEAD_CREATED',
  };

  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.CIS_WEBHOOK_BEARER_TOKEN}`,
  };
  // Header name unconfirmed with CIS — flagged to them separately; HMAC-SHA256 over the raw JSON
  // body is the standard convention and easiest for them to swap the header name for on their end.
  if (env.CIS_WEBHOOK_HMAC_SECRET) {
    headers['X-Webhook-Signature'] = createHmac('sha256', env.CIS_WEBHOOK_HMAC_SECRET).update(json).digest('hex');
  }

  try {
    const res = await fetch(env.CIS_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: json,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Bug fixed 2026-11-16: neither branch below used to log the response BODY at all — only the
    // status code, and only on a non-2xx. A real case showed this gap directly: CIS's server
    // returned 200 (so this logged "sent", looking fully successful) but never actually created a
    // lead on their end — with no body logged, there was nothing to hand back to them to debug
    // what their own server actually said. Capped at 2000 chars so a misbehaving endpoint returning
    // something huge (an error page, a stack trace) can't blow up the log line.
    const responseBody = await res.text().catch(() => '<failed to read response body>');
    const truncatedBody = responseBody.length > 2000 ? `${responseBody.slice(0, 2000)}…` : responseBody;
    if (!res.ok) {
      logger.warn({ event: 'cis_webhook_non_2xx', status: res.status, leadId: input.leadId, responseBody: truncatedBody }, 'CIS webhook returned a non-2xx status');
      return;
    }
    logger.info({ event: 'cis_webhook_sent', leadId: input.leadId, product: input.product, status: res.status, responseBody: truncatedBody }, 'CIS lead-created webhook sent');
  } catch (err) {
    logger.error({ err, event: 'cis_webhook_failed', leadId: input.leadId }, 'CIS webhook POST failed — not retried, does not affect the customer\'s own journey');
  }
}
