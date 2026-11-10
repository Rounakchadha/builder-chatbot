import {
  LAS_DEPOSITORY_PARTICIPANTS,
  LAS_FUNDS_TIMELINE,
  LAS_INVESTMENT_VALUE_BANDS,
  LAS_MUTUAL_FUND_HOLDING_MODES,
  LAS_MUTUAL_FUND_TYPES,
  LAS_TYPES,
  type EligibilityResultPayload,
} from '@builder-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { maskMobile, maskPan } from '../lib/crypto';
import { leadCreatedMessage, pickRm } from './rm';
import { ensureLeadOnce, type LeadSyncResult } from '../services/lead.service';
import { sendLeadCreatedWebhook } from '../services/webhook.service';

/**
 * Loan Against Securities (shares / mutual funds) — branches off homeLoan.ts's 'product' step,
 * right after the full, real identity chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent —
 * see personalLoan.ts's doc comment and flows/index.ts for the shared architecture notes).
 * ctx.answers.name/mobile/segment/pan are already real by this point, reused directly below.
 *
 * Deliberately simpler than every other product: no eligibility/offers at all — just collects the
 * details, then creates a lead and stops (direct instruction, 2026-10-16: "end mein sirf lead id
 * banke khatam no eligibility"). Lead creation IS real (confirmed live, 2026-10-16) — reuses the
 * same create_anacity_lead call Home Loan/LAP use, with product_code 'LAS' (see
 * lead.service.ts's PRODUCT_CODE) — it assigns a real RM in its own response, same as HL/LAP.
 *
 * Bitsflow separately confirmed LAS also has a product_id (32) under the OTHER lead-creation
 * family (createcorplead — the one Gold/Personal/Business Loan use), but that one does NOT return
 * an RM. create_anacity_lead was used instead specifically because it does. Noting 32 here only in
 * case a future LAS-specific detail endpoint (the createcorplead-family equivalent of
 * businessloandtl/setmuthootlenderoffer) turns out to require a lead created via THAT family
 * instead — not needed for anything built so far.
 */
function isLAS(ctx: StepContext): boolean {
  return ctx.answers.product === 'Loan Against Securities';
}

function isSharesVariant(ctx: StepContext): boolean {
  return isLAS(ctx) && ctx.answers.lasType === 'Loan Against Shares';
}

function isMutualFundVariant(ctx: StepContext): boolean {
  return isLAS(ctx) && ctx.answers.lasType === 'Loan Against Mutual Funds';
}

/** A recap of everything collected, shown once right before the final result (lead id + RM) —
 * same spirit as homeLoan.ts's buildProfileSummary. */
function buildLasSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${a.name}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${a.mobile}`);
  if (a.lasType) lines.push(`<strong>Looking for:</strong> ${a.lasType}`);
  if (a.lasLoanAmount) lines.push(`<strong>Loan amount requested:</strong> ₹${Number(a.lasLoanAmount).toLocaleString('en-IN')}`);
  if (a.lasInvestmentValue) lines.push(`<strong>Investment value:</strong> ${a.lasInvestmentValue}`);
  if (a.lasMutualFundType) lines.push(`<strong>Mutual fund type:</strong> ${a.lasMutualFundType}`);
  if (a.lasMutualFundHolding) lines.push(`<strong>Held via:</strong> ${a.lasMutualFundHolding}`);
  if (a.lasDepository) lines.push(`<strong>Depository participant:</strong> ${a.lasDepository}`);
  if (a.lasFundsTimeline) lines.push(`<strong>Funds needed:</strong> ${a.lasFundsTimeline}`);
  return `Here's what I've got so far:<br>${lines.join('<br>')}`;
}

/** Same fields as buildLasSummary above, structured for the RM notification email instead of a
 * chat bubble (2026-10-21 instruction: "send all the product info that is captured" for LAS). */
export function buildLasRmDetails(ctx: StepContext): Array<{ label: string; value: string }> {
  const a = ctx.answers;
  const rows: Array<{ label: string; value: string }> = [];
  // No separate "Looking for"/lasType row here — resultPayload.loanType IS ctx.answers.lasType (see
  // this file's own lasResult step), so the generic "Loan type" row in every RM email already shows
  // this exact value; a second row here would just repeat it (2026-10-21 bug report).
  if (a.lasLoanAmount) rows.push({ label: 'Loan amount requested', value: `₹${Number(a.lasLoanAmount).toLocaleString('en-IN')}` });
  if (a.lasInvestmentValue) rows.push({ label: 'Investment value', value: a.lasInvestmentValue as string });
  if (a.lasMutualFundType) rows.push({ label: 'Mutual fund type', value: a.lasMutualFundType as string });
  if (a.lasMutualFundHolding) rows.push({ label: 'Held via', value: a.lasMutualFundHolding as string });
  if (a.lasDepository) rows.push({ label: 'Depository participant', value: a.lasDepository as string });
  if (a.lasFundsTimeline) rows.push({ label: 'Funds needed', value: a.lasFundsTimeline as string });
  return rows;
}

export const loanAgainstSharesSteps: StepDefinition[] = [
  {
    id: 'lasType',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isLAS,
    botMessage: () => 'What are you looking for?',
    input: () => ({ type: 'choice', options: [...LAS_TYPES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasType', [...LAS_TYPES], value, `Which of these is it: ${LAS_TYPES.join(', ')}?`),
  },
  {
    id: 'lasLoanAmount',
    type: 'number',
    progressLabel: 'Loan Against Securities',
    isApplicable: isLAS,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 500000, or 5 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 10_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 500000.' };
      // Security-review finding, 2026-10-23: no upper bound existed — same "sanity floor" reasoning
      // as homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT.
      if (v > 50_00_00_000) return { ok: false, error: "That doesn't look right — enter the loan amount you need (up to ₹50 crore)." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'lasInvestmentValue',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isLAS,
    botMessage: () => 'What is your approximate shares/mutual fund investment value?',
    input: () => ({ type: 'choice', options: [...LAS_INVESTMENT_VALUE_BANDS], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasInvestmentValue', [...LAS_INVESTMENT_VALUE_BANDS], value, `Which of these is it: ${LAS_INVESTMENT_VALUE_BANDS.join(', ')}?`),
  },
  {
    id: 'lasMutualFundType',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isMutualFundVariant,
    botMessage: () => 'What type of mutual funds do you hold?',
    input: () => ({ type: 'choice', options: [...LAS_MUTUAL_FUND_TYPES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasMutualFundType', [...LAS_MUTUAL_FUND_TYPES], value, `Which of these is it: ${LAS_MUTUAL_FUND_TYPES.join(', ')}?`),
  },
  {
    id: 'lasMutualFundHolding',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isMutualFundVariant,
    botMessage: () => 'How are your mutual funds held?',
    input: () => ({ type: 'choice', options: [...LAS_MUTUAL_FUND_HOLDING_MODES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasMutualFundHolding', [...LAS_MUTUAL_FUND_HOLDING_MODES], value, `Which of these is it: ${LAS_MUTUAL_FUND_HOLDING_MODES.join(', ')}?`),
  },
  {
    id: 'lasDepository',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isSharesVariant,
    botMessage: () => 'Which DP are your shares held with?',
    input: () => ({ type: 'choice', options: [...LAS_DEPOSITORY_PARTICIPANTS], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasDepository', [...LAS_DEPOSITORY_PARTICIPANTS], value, `Which of these is it: ${LAS_DEPOSITORY_PARTICIPANTS.join(', ')}?`),
  },
  {
    id: 'lasFundsTimeline',
    type: 'choice',
    progressLabel: 'Loan Against Securities',
    isApplicable: isLAS,
    botMessage: () => 'When do you need the funds?',
    input: () => ({ type: 'choice', options: [...LAS_FUNDS_TIMELINE], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'lasFundsTimeline', [...LAS_FUNDS_TIMELINE], value, `Which of these is it: ${LAS_FUNDS_TIMELINE.join(', ')}?`),
  },
  {
    id: 'lasProfileSummary',
    type: 'message',
    progressLabel: 'Your application',
    isApplicable: isLAS,
    botMessage: (ctx) => buildLasSummary(ctx),
    input: () => ({ type: 'none' }),
  },
  {
    // Separate apiFetch step (shows a loading state) for the real Finfinity lead-creation call —
    // same pattern as homeLoan.ts's triggerOtpDedupe. lasResult below just reads the result.
    id: 'lasCreateLead',
    type: 'apiFetch',
    progressLabel: 'Your application',
    isApplicable: isLAS,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx): Promise<{ lasLeadResult: LeadSyncResult }> => {
      const lasLeadResult = await ensureLeadOnce({
        conversationId: ctx.conversationId,
        rawPan: ctx.answers.pan as string,
        panMasked: maskPan(ctx.answers.pan as string),
        name: ctx.answers.name as string | undefined,
        mobileMasked: ctx.answers.mobile ? maskMobile(ctx.answers.mobile as string) : undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        product: 'Loan Against Securities',
        loanType: ctx.answers.lasType as string,
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      // lasLoanAmount is already collected by this point (asked earlier in this flow, before lead
      // creation) — fire CIS's webhook here, with the full picture, rather than at lead-creation
      // time generically (2026-11-06: fire once all the relevant info for this product is in hand).
      if (lasLeadResult.builderLeadId && !lasLeadResult.reused) {
        void sendLeadCreatedWebhook({
          leadId: lasLeadResult.builderLeadId,
          name: ctx.answers.name as string | undefined,
          mobile: ctx.answers.mobile as string | undefined,
          email: ctx.answers.email as string | undefined,
          pan: ctx.answers.pan as string | undefined,
          product: 'Loan Against Securities',
          loanType: ctx.answers.lasType as string,
          segment: ctx.answers.segment as string | undefined,
          pincode: ctx.answers.pincode as string | undefined,
          city: ctx.answers.pincodeArea as string | undefined,
          loanAmount: Number(ctx.answers.lasLoanAmount) || undefined,
          monthlyIncome: 0, // LAS collects neither income nor profit — 0, per instruction (2026-11-06)
        });
      }
      return { lasLeadResult };
    },
  },
  {
    id: 'lasResult',
    type: 'result',
    progressLabel: 'Your application',
    isApplicable: isLAS,
    botMessage: (ctx) => {
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (!payload?.leadCreated) return 'All done.';
      return leadCreatedMessage(payload.leadId, payload.rm);
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload; applicationSubmitted?: boolean } => {
      const lead = ctx.answers.lasLeadResult as LeadSyncResult;
      const seedKey = (ctx.answers.mobile as string) || ctx.conversationId;
      // No eligibility/offers at all for this product (direct instruction) — just a lead. Falls
      // back to the placeholder RM only when running on the mock lead service (no real API
      // configured) — the real service always returns one (see PRODUCT_CODE's 'LAS' entry).
      const leadCreated = lead.status === 'synced';
      const resultPayload: EligibilityResultPayload = {
        eligible: true,
        name: ctx.answers.name as string | undefined,
        product: 'Loan Against Securities',
        loanType: ctx.answers.lasType as string,
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        rm: lead.rm ?? pickRm(seedKey),
        leadId: lead.builderLeadId ?? undefined,
        leadCreated,
      };
      // No explicit "submit" button for this product either (lead capture only) — a real lead
      // means the application already went in, same reasoning as Business Loan's blResult.
      return { resultPayload, applicationSubmitted: leadCreated || undefined };
    },
  },
];
