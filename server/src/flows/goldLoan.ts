import { GOLD_LOAN_PURPOSES, GOLD_PURITY_OPTIONS, GOLD_TYPES, type EligibilityResultPayload } from '@loan-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { mockOffersForAmount } from './mockOffers';
import { generateLeadId, leadCreatedMessage, pickRm } from './rm';

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

/**
 * Gold loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see personalLoan.ts's doc comment
 * and flows/index.ts for the shared architecture notes). ctx.answers.name/mobile/segment are
 * already real by this point, reused directly below. From here on it's fully DUMMY — no further
 * Finfinity API calls (lead creation/lender offers are mocked). Simplification: asks for one gold
 * item's purity/weight rather than a repeating list of items — fine for getting the flow itself
 * built; revisit if multi-item entry is actually needed.
 */
const GOLD_LENDERS = ['Muthoot Finance', 'Manappuram Finance', 'HDFC Bank', 'IIFL Finance'];

// Approximate ₹/gram by purity, for a believable mock cap — not real gold-rate data.
const PURITY_RATE_PER_GRAM: Record<string, number> = {
  '24k': 7000,
  '22k': 6400,
  '20k': 5800,
  '18k': 5250,
  'Not sure': 5000,
};

function isGoldLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Gold loan';
}

export const goldLoanSteps: StepDefinition[] = [
  {
    id: 'glLoanAmount',
    type: 'number',
    progressLabel: 'Gold loan',
    isApplicable: isGoldLoan,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 100000, or 1 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 5_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 100000.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'glGoldType',
    type: 'choice',
    progressLabel: 'Gold loan',
    isApplicable: isGoldLoan,
    botMessage: () => 'What type of gold are you pledging?',
    input: () => ({ type: 'choice', options: [...GOLD_TYPES], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'glGoldType', [...GOLD_TYPES], value, `Which of these is it: ${GOLD_TYPES.join(', ')}?`),
  },
  {
    id: 'glPurity',
    type: 'choice',
    progressLabel: 'Gold loan',
    isApplicable: isGoldLoan,
    botMessage: () => "What's the purity?",
    input: () => ({ type: 'choice', options: [...GOLD_PURITY_OPTIONS], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'glPurity', [...GOLD_PURITY_OPTIONS], value, `Which of these is it: ${GOLD_PURITY_OPTIONS.join(', ')}?`),
  },
  {
    id: 'glGrossWeight',
    type: 'number',
    progressLabel: 'Gold loan',
    isApplicable: isGoldLoan,
    botMessage: () => "What's the gross weight, in grams?",
    input: () => ({ type: 'number', placeholder: 'e.g. 50' }),
    validate: (value) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0 || v > 10_000) return { ok: false, error: 'Enter the gross weight in grams, e.g. 50.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'glLoanPurpose',
    type: 'choice',
    progressLabel: 'Gold loan',
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
      const name = (ctx.answers.name as string | undefined)?.split(' ')[0];
      const greeting = name ? `All done, ${name} — here's your gold loan eligibility.` : "All done — here's your gold loan eligibility.";
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (!payload?.leadCreated) return greeting;
      return `${greeting}<br><br>${leadCreatedMessage(payload.leadId, payload.rm)}`;
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
      const resultPayload: EligibilityResultPayload = {
        eligible: offers.length > 0 && offers[0].amountLakh > 0,
        name: ctx.answers.name as string | undefined,
        product: 'Gold loan',
        loanType: 'Gold loan',
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        financialEligibilityLakh: offers[0]?.amountLakh,
        offers,
        rm: pickRm(seedKey),
        leadId: generateLeadId(),
        leadCreated: true,
      };
      return { resultPayload };
    },
  },
];
