import { BUSINESS_LOAN_PURPOSES, BUSINESS_TYPES, INDUSTRY_TYPES, type EligibilityResultPayload } from '@loan-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { escapeHtml } from '../lib/escapeHtml';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { validateAddress, validateLandmark, validatePincode } from './addressValidation';
import { mockOffersForAmount } from './mockOffers';
import { pincodeService } from '../services/pincode.service';
import { generateLeadId, leadCreatedMessage, pickRm } from './rm';

/**
 * Business loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see personalLoan.ts's doc comment
 * and flows/index.ts for the shared architecture notes). ctx.answers.name/mobile/segment/
 * creditScore are already real by this point, reused directly below; `blPan` still asks for the
 * BUSINESS's own PAN as a plain, unverified field (not a lookup) since it can differ from the
 * applicant's personal PAN (partnership/LLP/Pvt Ltd). Business type / GST-registration are meant to
 * be auto-detected "on the basis of PAN" per spec — no such lookup is wired up yet, so both are
 * asked directly for now (matching the spec's own fallback: "if not identified, ask"). Lead
 * creation/lender offers are DUMMY for now too.
 */
const BUSINESS_LENDERS = ['Bajaj Finserv', 'HDFC Bank', 'ICICI Bank', 'Lendingkart', 'Tata Capital'];

const GST_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/;

function isBusinessLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Business loan';
}

function parseIncorporationYears(raw: string): number | null {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const years = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return years < 0 ? null : Math.floor(years * 10) / 10;
}

/** A recap of everything collected, shown once right before the final result (lead id + RM) —
 * same spirit as homeLoan.ts's buildProfileSummary. */
function buildBusinessLoanSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${escapeHtml(a.name as string)}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${a.mobile}`);
  if (a.blLoanAmount) lines.push(`<strong>Loan amount requested:</strong> ₹${Number(a.blLoanAmount).toLocaleString('en-IN')}`);
  if (a.blLoanPurpose) lines.push(`<strong>Loan purpose:</strong> ${a.blLoanPurpose}`);
  if (a.blPan) lines.push(`<strong>Business PAN:</strong> ${a.blPan}`);
  if (a.blBusinessType) lines.push(`<strong>Business type:</strong> ${a.blBusinessType}`);
  lines.push(`<strong>GST registered:</strong> ${a.blGstRegistered}${a.blGstNumber ? ` (${a.blGstNumber})` : ''}`);
  if (a.blBusinessAddress) {
    lines.push(
      `<strong>Business address:</strong> ${escapeHtml(a.blBusinessAddress as string)}, ${a.blBusinessPincode}${a.blBusinessPincodeArea ? ` (${escapeHtml(a.blBusinessPincodeArea as string)})` : ''} — ${escapeHtml(a.blBusinessLandmark as string)}`,
    );
  }
  if (a.blIndustry) lines.push(`<strong>Industry:</strong> ${a.blIndustry}`);
  if (a.blYearsInBusiness !== undefined) lines.push(`<strong>Years in business:</strong> ${a.blYearsInBusiness}`);
  if (a.blAnnualTurnover) lines.push(`<strong>Annual turnover:</strong> ₹${Number(a.blAnnualTurnover).toLocaleString('en-IN')}`);
  if (a.blAnnualProfit !== undefined) lines.push(`<strong>Annual profit:</strong> ₹${Number(a.blAnnualProfit).toLocaleString('en-IN')}`);
  return `Here's what I've got so far:<br>${lines.join('<br>')}`;
}

export const businessLoanSteps: StepDefinition[] = [
  {
    id: 'blLoanAmount',
    type: 'number',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 1000000, or 10 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 50_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 1000000.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blLoanPurpose',
    type: 'choice',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'What will you use it for?',
    input: () => ({ type: 'choice', options: [...BUSINESS_LOAN_PURPOSES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'blLoanPurpose', [...BUSINESS_LOAN_PURPOSES], value, `Which of these is it: ${BUSINESS_LOAN_PURPOSES.join(', ')}?`),
  },
  {
    id: 'blPan',
    type: 'pan',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "What's your business/your own PAN?",
    input: () => ({ type: 'pan' }),
    validate: (value) => {
      const v = (value || '').trim().toUpperCase();
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return { ok: false, error: 'Enter a valid PAN, e.g. ABCDE1234F.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blBusinessType',
    type: 'choice',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "What type of business is it?",
    input: () => ({ type: 'choice', options: [...BUSINESS_TYPES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'blBusinessType', [...BUSINESS_TYPES], value, `Which of these is it: ${BUSINESS_TYPES.join(', ')}?`),
  },
  {
    id: 'blGstRegistered',
    type: 'choice',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'Is your business GST registered?',
    input: () => ({ type: 'choice', options: ['Yes', 'No'], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'blGstRegistered', ['Yes', 'No'], value, 'Is it GST registered — yes or no?'),
  },
  {
    id: 'blGstNumber',
    type: 'text',
    progressLabel: 'Business loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && ctx.answers.blGstRegistered === 'Yes',
    botMessage: () => "What's your primary GST number?",
    input: () => ({ type: 'text', placeholder: 'e.g. 22AAAAA0000A1Z5' }),
    validate: (value) => {
      const v = (value || '').trim().toUpperCase();
      if (!GST_PATTERN.test(v)) return { ok: false, error: 'Enter a valid 15-character GST number, e.g. 22AAAAA0000A1Z5.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blBusinessAddress',
    type: 'text',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "What's your business address?",
    input: () => ({ type: 'text', placeholder: 'Shop/unit, street, area' }),
    validate: (value) => validateAddress(value),
  },
  {
    id: 'blBusinessLandmark',
    type: 'text',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'Any landmark near the business?',
    input: () => ({ type: 'text', placeholder: 'e.g. Near City Mall' }),
    validate: (value) => validateLandmark(value),
  },
  {
    id: 'blBusinessPincode',
    type: 'text',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'And the pincode for that address?',
    input: () => ({ type: 'text', placeholder: 'e.g. 400001', maxLength: 6 }),
    validate: (value) => validatePincode(value),
    onAnswer: async (parsed, ctx) => {
      const area = await pincodeService.lookupArea(parsed as string);
      return area ? { blBusinessPincodeArea: area } : undefined;
    },
  },
  {
    id: 'blBusinessPincodeConfirm',
    type: 'message',
    progressLabel: 'Business loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && Boolean(ctx.answers.blBusinessPincodeArea),
    botMessage: (ctx) => `Got it — ${ctx.answers.blBusinessPincode} is ${escapeHtml(ctx.answers.blBusinessPincodeArea as string)}.`,
    input: () => ({ type: 'none' }),
  },
  {
    id: 'blIndustry',
    type: 'choice',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'Which industry is the business in?',
    input: () => ({ type: 'choice', options: [...INDUSTRY_TYPES], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'blIndustry', [...INDUSTRY_TYPES], value, `Which of these is it: ${INDUSTRY_TYPES.join(', ')}?`),
  },
  {
    id: 'blIncorporationDate',
    type: 'text',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "What's the business's date of incorporation?",
    input: () => ({ type: 'date', max: new Date().toISOString().slice(0, 10) }),
    validate: (value) => {
      const years = parseIncorporationYears((value || '').trim());
      if (years === null) return { ok: false, error: 'Pick a valid date of incorporation.' };
      return { ok: true, parsed: (value || '').trim() };
    },
    onAnswer: (parsed) => ({ blYearsInBusiness: parseIncorporationYears(parsed as string) ?? undefined }),
  },
  {
    id: 'blAnnualTurnover',
    type: 'number',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "What's your annual turnover?",
    input: () => ({ type: 'number', placeholder: 'e.g. 5000000, or 50 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 1) return { ok: false, error: 'Enter your annual turnover — e.g. 5000000.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blAnnualProfit',
    type: 'number',
    progressLabel: 'Business loan',
    isApplicable: isBusinessLoan,
    botMessage: () => "And your annual profit?",
    input: () => ({ type: 'number', placeholder: 'e.g. 800000, or 8 lakh' }),
    validate: (value, ctx) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: 'Enter your annual profit — e.g. 800000.' };
      const turnover = Number(ctx.answers.blAnnualTurnover);
      if (turnover && v > turnover) return { ok: false, error: 'Annual profit cannot be more than annual turnover.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blProfileSummary',
    type: 'message',
    progressLabel: 'Your eligibility',
    isApplicable: isBusinessLoan,
    botMessage: (ctx) => buildBusinessLoanSummary(ctx),
    input: () => ({ type: 'none' }),
  },
  {
    id: 'blResult',
    type: 'result',
    progressLabel: 'Your eligibility',
    isApplicable: isBusinessLoan,
    botMessage: (ctx) => {
      const name = (ctx.answers.name as string | undefined)?.split(' ')[0];
      const greeting = name ? `All done, ${name} — here's your business loan eligibility.` : "All done — here's your business loan eligibility.";
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (!payload?.leadCreated) return greeting;
      return `${greeting}<br><br>${leadCreatedMessage(payload.leadId, payload.rm)}`;
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload } => {
      const requestedLakh = Number(ctx.answers.blLoanAmount) / 100_000;
      const turnoverLakh = Number(ctx.answers.blAnnualTurnover) / 100_000;
      // Rough, placeholder cap — about a third of annual turnover — until the real BRE is wired up.
      const turnoverCappedLakh = turnoverLakh * 0.35;
      const cappedRequestLakh = Math.min(requestedLakh, turnoverCappedLakh);

      const seedKey = (ctx.answers.blPan as string) || (ctx.answers.mobile as string) || ctx.conversationId;
      const offers = mockOffersForAmount(cappedRequestLakh, BUSINESS_LENDERS, seedKey, 14, 5);
      const resultPayload: EligibilityResultPayload = {
        eligible: offers.length > 0 && offers[0].amountLakh > 0,
        name: ctx.answers.name as string | undefined,
        product: 'Business loan',
        loanType: 'Business loan',
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
