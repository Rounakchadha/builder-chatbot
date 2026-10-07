import { QUALIFICATION_TYPES, RESIDENCE_TYPES, type EligibilityResultPayload } from '@loan-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { escapeHtml } from '../lib/escapeHtml';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { validateAddress, validateLandmark, validatePincode } from './addressValidation';
import { mockOffersForAmount } from './mockOffers';
import { pincodeService } from '../services/pincode.service';
import { isKnownEmployer } from '../services/employer.service';
import { eligibleLendersForPincode } from '../services/pincodeEligibility.service';
import { generateLeadId, leadCreatedMessage, pickRm } from './rm';

const EMPLOYER_OTHER = 'Others';

/**
 * Personal loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see flows/index.ts). By this point
 * ctx.answers.pan/name/email/segment/creditScore/mobile are already real, whether the customer was
 * already known (dedupeCheck's found branch) or brand new (the not-found branch's own PAN lookup +
 * bureau pull) — reused directly here instead of asking again. Only gender (not collected by the
 * shared chain) and the personal-loan-specific fields below are asked fresh. Lead creation and
 * lender offers are DUMMY for now (no confirmed Finfinity product code/API for personal loans yet)
 * — see mockOffers.ts. Every answer id is prefixed `pl` so it can never collide with an
 * identically-named step elsewhere in the combined flow array.
 */
const PL_LENDERS = ['Bajaj Finserv', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Tata Capital', 'IDFC First Bank'];

function isPersonalLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Personal loan';
}

/** A recap of everything collected, shown once right before the final result (lead id + RM) —
 * same spirit as homeLoan.ts's buildProfileSummary, lets the customer see what was actually
 * captured before the application is wrapped up. */
function buildPersonalLoanSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${escapeHtml(a.name as string)}`);
  if (a.gender) lines.push(`<strong>Gender:</strong> ${a.gender}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${a.mobile}`);
  if (a.pan) lines.push(`<strong>PAN:</strong> ${a.pan}`);
  if (a.email) lines.push(`<strong>Email:</strong> ${escapeHtml(a.email as string)}`);
  if (a.segment) lines.push(`<strong>Employment:</strong> ${a.segment}`);
  if (a.creditScore) lines.push(`<strong>CIBIL score:</strong> ${a.creditScore}`);
  if (a.plEmployer) lines.push(`<strong>Employer:</strong> ${escapeHtml((a.plEmployerOther as string) ?? (a.plEmployer as string))}`);
  if (a.plLoanAmount) lines.push(`<strong>Loan amount requested:</strong> ₹${Number(a.plLoanAmount).toLocaleString('en-IN')}`);
  if (a.plIncome) lines.push(`<strong>Monthly income:</strong> ₹${Number(a.plIncome).toLocaleString('en-IN')}`);
  lines.push(`<strong>Existing EMIs:</strong> ${a.plEmi ? `₹${Number(a.plEmi).toLocaleString('en-IN')}/month` : 'None'}`);
  if (a.plQualification) lines.push(`<strong>Qualification:</strong> ${a.plQualification}`);
  if (a.plFatherName) lines.push(`<strong>Father's name:</strong> ${escapeHtml(a.plFatherName as string)}`);
  if (a.plMotherName) lines.push(`<strong>Mother's name:</strong> ${escapeHtml(a.plMotherName as string)}`);
  if (a.plResidenceAddress) {
    lines.push(
      `<strong>Residence:</strong> ${escapeHtml(a.plResidenceAddress as string)}, ${a.plResidencePincode}${a.plResidencePincodeArea ? ` (${escapeHtml(a.plResidencePincodeArea as string)})` : ''} — ${escapeHtml(a.plResidenceLandmark as string)}`,
    );
  }
  if (a.plResidenceType) lines.push(`<strong>Residence type:</strong> ${a.plResidenceType}`);
  if (a.plLoanPurpose) lines.push(`<strong>Loan purpose:</strong> ${escapeHtml(a.plLoanPurpose as string)}`);

  return `Here's what I've got so far:<br>${lines.join('<br>')}`;
}

export const personalLoanSteps: StepDefinition[] = [
  {
    // Only asked as a fallback — gender normally already comes from the PAN lookup/dedupe match
    // (see pan.service.ts/dedupe.service.ts), same as name/DOB.
    id: 'plGender',
    type: 'choice',
    progressLabel: 'Personal loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !ctx.answers.gender,
    botMessage: () => "What's your gender?",
    input: () => ({ type: 'choice', options: ['Male', 'Female', 'Other'], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'plGender', ['Male', 'Female', 'Other'], value, 'Is that male, female, or other?'),
    onAnswer: (parsed) => ({ gender: parsed }),
  },
  {
    id: 'plLoanAmount',
    type: 'number',
    progressLabel: 'Personal loan',
    isApplicable: isPersonalLoan,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 500000, or 5 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 10_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 500000.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plIncome',
    type: 'number',
    progressLabel: 'Personal loan',
    isApplicable: isPersonalLoan,
    botMessage: () => "What's your monthly income?",
    hint: () => 'Net take-home, or average monthly income if self-employed.',
    input: () => ({ type: 'number', placeholder: 'e.g. 60000' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 5_000) return { ok: false, error: 'Enter your actual monthly income — e.g. 60000.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plEmi',
    type: 'number',
    progressLabel: 'Personal loan',
    isApplicable: isPersonalLoan,
    botMessage: () => 'Do you currently have any other loan EMIs?',
    hint: () => 'Say "no" if you don\'t have any.',
    input: () => ({ type: 'number', placeholder: "e.g. 8000, or 'no'" }),
    validate: (value) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: "Enter the amount, or say 'no' if you don't have any." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plEmployer',
    type: 'text',
    progressLabel: 'Personal loan',
    isApplicable: isPersonalLoan,
    botMessage: () => "Who's your employer?",
    hint: () => "Start typing to search, or pick \"Others\" if it's not listed.",
    input: () => ({ type: 'typeahead', placeholder: 'Start typing your company name', searchKey: 'employer' }),
    validate: (value) => {
      const v = (value || '').trim();
      if (v === EMPLOYER_OTHER) return { ok: true, parsed: v };
      if (!isKnownEmployer(v)) return { ok: false, error: 'Pick your employer from the search results, or choose "Others".' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plEmployerOther',
    type: 'text',
    progressLabel: 'Personal loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && ctx.answers.plEmployer === EMPLOYER_OTHER,
    botMessage: () => "What's the name of your employer?",
    input: () => ({ type: 'text', placeholder: 'Employer name' }),
    validate: (value) => {
      const v = (value || '').trim();
      if (v.length < 2) return { ok: false, error: "Enter your employer's name." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plOffers',
    type: 'apiFetch',
    progressLabel: 'Your offers',
    isApplicable: isPersonalLoan,
    botMessage: (ctx) => {
      const offers = ctx.answers.plOffers as { name: string; amountLakh: number }[] | undefined;
      if (!offers?.length) return "Here's what we found — let's finish your application to lock in an offer.";
      return `Good news — based on what you've shared, you're looking at offers up to <strong>₹${offers[0].amountLakh} lakh</strong>. Let's finish your application.`;
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx) => {
      const requestedLakh = Number(ctx.answers.plLoanAmount) / 100_000;
      const seedKey = (ctx.answers.pan as string) || (ctx.answers.mobile as string) || ctx.conversationId;
      const offers = mockOffersForAmount(requestedLakh, PL_LENDERS, seedKey, 13, 5);
      // Computed and stashed now, not yet shown or used to filter `offers` above (still mocked) —
      // see pincodeEligibility.service.ts's doc comment: wire this into the real offers/result once
      // Personal loan actually shows real eligibility instead of mock data.
      const plEligibleLenders = ctx.answers.pincode ? eligibleLendersForPincode(ctx.answers.pincode as string) : undefined;
      return { plOffers: offers, plLeadId: generateLeadId(), plEligibleLenders };
    },
  },
  {
    id: 'plTnc',
    type: 'choice',
    progressLabel: 'Terms & conditions',
    isApplicable: isPersonalLoan,
    botMessage: () => 'Before we continue — please confirm you agree to the Terms & Conditions and the Key Fact Statement (KFS).',
    input: () => ({ type: 'choice', options: ['I agree'], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'plTnc', ['I agree'], value, 'Please confirm you agree to continue.'),
  },
  {
    id: 'plFatherName',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => "What's your father's name?",
    input: () => ({ type: 'text', placeholder: "Father's name" }),
    validate: (value) => ((value || '').trim().length >= 2 ? { ok: true, parsed: value!.trim() } : { ok: false, error: "Enter your father's name." }),
  },
  {
    id: 'plMotherName',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => "And your mother's name?",
    input: () => ({ type: 'text', placeholder: "Mother's name" }),
    validate: (value) => ((value || '').trim().length >= 2 ? { ok: true, parsed: value!.trim() } : { ok: false, error: "Enter your mother's name." }),
  },
  {
    id: 'plCurrentExp',
    type: 'number',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => 'How many years have you been with your current employer?',
    input: () => ({ type: 'number', placeholder: 'e.g. 2' }),
    validate: (value) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 60) return { ok: false, error: 'Enter the number of years, e.g. 2.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plOverallExp',
    type: 'number',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => 'And your overall work experience, in years?',
    input: () => ({ type: 'number', placeholder: 'e.g. 6' }),
    validate: (value, ctx) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 60) return { ok: false, error: 'Enter the number of years, e.g. 6.' };
      const current = Number(ctx.answers.plCurrentExp) || 0;
      if (v < current) return { ok: false, error: 'Overall experience should be at least your current-employer tenure.' };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plQualification',
    type: 'choice',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => "What's your highest qualification?",
    input: () => ({ type: 'choice', options: [...QUALIFICATION_TYPES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'plQualification', [...QUALIFICATION_TYPES], value, `Which of these is it: ${QUALIFICATION_TYPES.join(', ')}?`),
  },
  {
    id: 'plResidenceAddress',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => "What's your residence address?",
    input: () => ({ type: 'text', placeholder: 'House/flat, street, area' }),
    validate: (value) => validateAddress(value),
  },
  {
    id: 'plResidencePincode',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => 'And the pincode for that address?',
    input: () => ({ type: 'text', placeholder: 'e.g. 400001', maxLength: 6 }),
    validate: (value) => validatePincode(value),
    onAnswer: async (parsed, ctx) => {
      const area = await pincodeService.lookupArea(parsed as string);
      return area ? { plResidencePincodeArea: area } : undefined;
    },
  },
  {
    id: 'plResidencePincodeConfirm',
    type: 'message',
    progressLabel: 'A few more details',
    isApplicable: (ctx) => isPersonalLoan(ctx) && Boolean(ctx.answers.plResidencePincodeArea),
    botMessage: (ctx) => `Got it — ${ctx.answers.plResidencePincode} is ${escapeHtml(ctx.answers.plResidencePincodeArea as string)}.`,
    input: () => ({ type: 'none' }),
  },
  {
    id: 'plResidenceLandmark',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => 'Any landmark near your residence?',
    input: () => ({ type: 'text', placeholder: 'e.g. Near City Mall' }),
    validate: (value) => validateLandmark(value),
  },
  {
    id: 'plResidenceType',
    type: 'choice',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => 'Is your residence owned, rented, or family owned?',
    input: () => ({ type: 'choice', options: [...RESIDENCE_TYPES], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'plResidenceType', [...RESIDENCE_TYPES], value, `Which of these is it: ${RESIDENCE_TYPES.join(', ')}?`),
  },
  {
    id: 'plLoanPurpose',
    type: 'text',
    progressLabel: 'A few more details',
    isApplicable: isPersonalLoan,
    botMessage: () => "Last question — what's this loan for?",
    input: () => ({ type: 'text', placeholder: 'e.g. Medical expenses, wedding, travel' }),
    validate: (value) => ((value || '').trim().length >= 2 ? { ok: true, parsed: value!.trim() } : { ok: false, error: 'Tell us what this loan is for.' }),
  },
  {
    id: 'plProfileSummary',
    type: 'message',
    progressLabel: 'Your eligibility',
    isApplicable: isPersonalLoan,
    botMessage: (ctx) => buildPersonalLoanSummary(ctx),
    input: () => ({ type: 'none' }),
  },
  {
    id: 'plResult',
    type: 'result',
    progressLabel: 'Your eligibility',
    isApplicable: isPersonalLoan,
    botMessage: (ctx) => {
      const name = (ctx.answers.name as string | undefined)?.split(' ')[0];
      const greeting = name ? `All done, ${escapeHtml(name)} — here's your personal loan summary.` : "All done — here's your personal loan summary.";
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (!payload?.leadCreated) return greeting;
      return `${greeting}<br><br>${leadCreatedMessage(payload.leadId, payload.rm)}`;
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload } => {
      const offers = (ctx.answers.plOffers as EligibilityResultPayload['offers']) ?? [];
      const seedKey = (ctx.answers.pan as string) || (ctx.answers.mobile as string) || ctx.conversationId;
      const resultPayload: EligibilityResultPayload = {
        eligible: offers.length > 0,
        name: ctx.answers.name as string | undefined,
        product: 'Personal loan',
        loanType: 'Personal loan',
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        financialEligibilityLakh: offers[0]?.amountLakh,
        offers,
        rm: pickRm(seedKey),
        leadId: ctx.answers.plLeadId as string | undefined,
        leadCreated: true,
      };
      return { resultPayload };
    },
  },
];
