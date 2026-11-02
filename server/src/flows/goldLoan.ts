import { GOLD_LOAN_PURPOSES, GOLD_PURITY_OPTIONS, GOLD_TYPES, type EligibilityResultPayload } from '@builder-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { maskMobile, maskPan } from '../lib/crypto';
import { mockOffersForAmount } from './mockOffers';
import { ensureLeadOnce, type LeadSyncResult } from '../services/lead.service';

/** A recap of everything collected, shown once right before the final result (lead id + RM) —
 * same spirit as homeLoan.ts's buildProfileSummary. */
function buildGoldLoanSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${a.name}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${a.mobile}`);
  if (a.glLoanAmount) lines.push(`<strong>Loan amount requested:</strong> ₹${Number(a.glLoanAmount).toLocaleString('en-IN')}`);
  if (a.glGoldType) lines.push(`<strong>Gold type:</strong> ${a.glGoldType}`);
  if (a.glPurity) lines.push(`<strong>Purity:</strong> ${a.glPurity}`);
  if (a.glGrossWeight) lines.push(`<strong>Gross weight:</strong> ${a.glGrossWeight}g`);
  if (a.glLoanPurpose) lines.push(`<strong>Loan purpose:</strong> ${a.glLoanPurpose}`);
  return `Here's what I've got so far:<br>${lines.join('<br>')}`;
}

/** Same fields as buildGoldLoanSummary above, structured for the RM notification email instead of
 * a chat bubble (2026-10-21 instruction: "send all the product info that is captured" for GL). */
export function buildGoldLoanRmDetails(ctx: StepContext): Array<{ label: string; value: string }> {
  const a = ctx.answers;
  const rows: Array<{ label: string; value: string }> = [];
  if (a.glLoanAmount) rows.push({ label: 'Loan amount requested', value: `₹${Number(a.glLoanAmount).toLocaleString('en-IN')}` });
  if (a.glGoldType) rows.push({ label: 'Gold type', value: a.glGoldType as string });
  if (a.glPurity) rows.push({ label: 'Purity', value: a.glPurity as string });
  if (a.glGrossWeight) rows.push({ label: 'Gross weight', value: `${a.glGrossWeight}g` });
  if (a.glLoanPurpose) rows.push({ label: 'Loan purpose', value: a.glLoanPurpose as string });
  return rows;
}

/**
 * Gold Loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see personalLoan.ts's doc comment
 * and flows/index.ts for the shared architecture notes). ctx.answers.name/mobile/segment are
 * already real by this point, reused directly below. The eligibility SHOWN here is still a dummy
 * local LTV calculation (no real gold-loan BRE exists yet) — nothing real touches Finfinity for the
 * eligibility numbers themselves. The real lead (`glCreateLead`) IS created immediately on entering
 * this branch, same as every other product (2026-10-21 instruction — a generic create_anacity_lead
 * doesn't attach any lender, so it never risks the "one Muthoot lead per customer" constraint);
 * only the Muthoot-specific attach+submit (setmuthootlenderoffer/muthootleadgeneration) stays
 * deferred until the customer taps "Submit to Muthoot" (see services/goldLoan.service.ts's
 * submitApplication and routes/chat.ts's gold-submit endpoint) — those two calls are what
 * permanently consume that one-per-customer slot, confirmed live (2026-10-15), which is why only
 * they (not lead creation) ever needed to wait for explicit customer action. Simplification: asks
 * for one gold item's purity/weight rather than a repeating list of items — fine for getting the
 * flow itself built; revisit if multi-item entry is actually needed.
 */
// Only one lender for gold loan, per instruction — mockOffersForAmount still works fine with a
// single-entry list, it just produces one offer instead of several to pick a "best" from.
const GOLD_LENDERS = ['Muthoot Finance'];

// Approximate ₹/gram by purity, for a believable mock cap — not real gold-rate data.
const PURITY_RATE_PER_GRAM: Record<string, number> = {
  '24k': 7000,
  '22k': 6400,
  '20k': 5800,
  '18k': 5250,
  'Not sure': 5000,
};

function isGoldLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Gold Loan';
}

export const goldLoanSteps: StepDefinition[] = [
  {
    // Fires the moment the customer picks Gold Loan — same "create the lead the moment we can"
    // pattern as Business/Personal Loan now use (2026-10-21 instruction: "we already get the rm
    // before we click the muthoot loan"). Safe to do unconditionally: create_anacity_lead alone
    // doesn't attach Muthoot or submit anything, so it never touches the "one Muthoot lead per
    // customer" constraint that setmuthootlenderoffer/muthootleadgeneration do — only THOSE two
    // calls still wait for the explicit "Submit to Muthoot" click (see goldLoan.service.ts).
    id: 'glCreateLead',
    type: 'apiFetch',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx): Promise<{ glLeadResult: LeadSyncResult }> => {
      const glLeadResult = await ensureLeadOnce({
        conversationId: ctx.conversationId,
        rawPan: ctx.answers.pan as string,
        panMasked: maskPan(ctx.answers.pan as string),
        name: ctx.answers.name as string | undefined,
        mobileMasked: ctx.answers.mobile ? maskMobile(ctx.answers.mobile as string) : undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        product: 'Gold Loan',
        loanType: 'Gold Loan',
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      return { glLeadResult };
    },
  },
  {
    id: 'glLoanAmount',
    type: 'number',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 100000, or 1 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 5_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 100000.' };
      // Security-review finding, 2026-10-23: no upper bound existed — same "sanity floor, not a
      // business rule" reasoning as homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT, just for Gold Loan's own
      // amount field (the real LTV cap below already bounds what's actually offered either way).
      if (v > 5_00_00_000) return { ok: false, error: "That doesn't look right — enter the loan amount you need (up to ₹5 crore)." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'glGoldType',
    type: 'choice',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => 'What type of gold are you pledging?',
    input: () => ({ type: 'choice', options: [...GOLD_TYPES], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'glGoldType', [...GOLD_TYPES], value, `Which of these is it: ${GOLD_TYPES.join(', ')}?`),
  },
  {
    id: 'glPurity',
    type: 'choice',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => "What's the purity?",
    input: () => ({ type: 'choice', options: [...GOLD_PURITY_OPTIONS], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'glPurity', [...GOLD_PURITY_OPTIONS], value, `Which of these is it: ${GOLD_PURITY_OPTIONS.join(', ')}?`),
  },
  {
    id: 'glGrossWeight',
    type: 'number',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => "What's the gross weight, in grams?",
    input: () => ({ type: 'number', placeholder: 'e.g. 50' }),
    validate: (value) => {
      // Bug fixed 2026-11-02 (direct instruction: typing "1 gm" instead of a bare "1" should still
      // work) — plain Number(value) returns NaN for anything with trailing text (a unit, "gms",
      // "grams", etc.), rejecting an otherwise perfectly clear answer. Extracts the leading numeric
      // portion instead, same spirit as parseAmount.ts's unit-shorthand handling elsewhere in this
      // flow, just for a weight rather than a currency amount.
      const match = (value ?? '').match(/[\d.]+/);
      const v = match ? Number(match[0]) : NaN;
      if (!Number.isFinite(v) || v <= 0 || v > 10_000) return { ok: false, error: 'Enter the gross weight in grams, e.g. 50.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'glLoanPurpose',
    type: 'choice',
    progressLabel: 'Gold Loan',
    isApplicable: isGoldLoan,
    botMessage: () => "What's this loan for?",
    input: () => ({ type: 'choice', options: [...GOLD_LOAN_PURPOSES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'glLoanPurpose', [...GOLD_LOAN_PURPOSES], value, `Which of these is it: ${GOLD_LOAN_PURPOSES.join(', ')}?`),
  },
  {
    id: 'glProfileSummary',
    type: 'message',
    progressLabel: 'Your eligibility',
    isApplicable: isGoldLoan,
    botMessage: (ctx) => buildGoldLoanSummary(ctx),
    input: () => ({ type: 'none' }),
  },
  {
    id: 'glResult',
    type: 'result',
    progressLabel: 'Your eligibility',
    isApplicable: isGoldLoan,
    botMessage: (ctx) => {
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (!payload?.eligible) return 'All done.';
      return "Here's what you're eligible for with Muthoot Finance — tap below to submit your application.";
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload } => {
      const requestedLakh = Number(ctx.answers.glLoanAmount) / 100_000;
      const weight = Number(ctx.answers.glGrossWeight) || 0;
      const rate = PURITY_RATE_PER_GRAM[ctx.answers.glPurity as string] ?? PURITY_RATE_PER_GRAM['Not sure'];
      const goldValueLakh = (weight * rate) / 100_000;
      const ltvCappedLakh = goldValueLakh * 0.75; // typical gold-loan LTV ceiling
      const cappedRequestLakh = Math.min(requestedLakh, ltvCappedLakh);

      const seedKey = (ctx.answers.mobile as string) || ctx.conversationId;
      const offers = mockOffersForAmount(cappedRequestLakh, GOLD_LENDERS, seedKey, 10.5, 3);
      // The real lead (and real RM) already exist by this point — glCreateLead runs the moment
      // this branch was entered, same as every other product now does (2026-10-21). Only the
      // Muthoot-specific attach+submit is still deferred to the explicit "Submit to Muthoot" click.
      const lead = ctx.answers.glLeadResult as LeadSyncResult | undefined;
      const resultPayload: EligibilityResultPayload = {
        eligible: offers.length > 0 && offers[0].amountLakh > 0,
        name: ctx.answers.name as string | undefined,
        product: 'Gold Loan',
        loanType: 'Gold Loan',
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        financialEligibilityLakh: offers[0]?.amountLakh,
        offers,
        rm: lead?.rm ?? { name: 'Our team', phone: '', email: '' },
        leadId: lead?.builderLeadId ?? undefined,
        leadCreated: Boolean(lead?.builderLeadId),
        // The amount/rate above come from a real weight x purity x LTV formula, but the per-gram
        // rate and interest rate are still placeholders, not Muthoot's live pricing (2026-10-23) —
        // tell the widget to label this as an estimate instead of a locked offer.
        isEstimate: true,
      };
      return { resultPayload };
    },
  },
];
