import type { EligibilityResultPayload, LenderOffer } from '@builder-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { env } from '../config/env';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { isKnownEmployer } from '../services/employer.service';
import { mapSegmentToEmploymentType, LENDER_DISPLAY_NAME, personalLoanEligibilityService, type PlEligibilityFacts } from '../services/personalLoanEligibility.service';
import { personalLoanFinancerService, type PlFinancerLenderEntry, type PlLenderComparisonResult } from '../services/personalLoanFinancer.service';
import { calcAge } from './homeLoan';
import { pickRm } from './rm';
import { leadService, type LeadSyncResult } from '../services/lead.service';
import { maskPan } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';

const EMPLOYER_OTHER = 'Others';

// Security-review finding, 2026-10-23: no upper bound existed on loan amount or income — see
// homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT doc comment for the same reasoning, applied here.
const MAX_SANE_LOAN_AMOUNT = 50_00_00_000; // ₹50 crore
const MAX_SANE_MONTHLY_AMOUNT = 1_00_00_000; // ₹1 crore/month

/**
 * Personal Loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see flows/index.ts). By this point
 * ctx.answers.pan/name/email/segment/creditScore/mobile are already real, whether the customer was
 * already known (dedupeCheck's found branch) or brand new (the not-found branch's own PAN lookup +
 * bureau pull) — reused directly here instead of asking again. Only gender (not collected by the
 * shared chain) and the personal-loan-specific fields below are asked fresh. Lead creation is still
 * DUMMY (no confirmed Finfinity product code/API for personal loans yet), but lender offers now
 * come from the real pre-check service (FINFINITY-BRE-MAIN/pl-eligibility-precheck, via
 * services/personalLoanEligibility.service.ts) — real gate logic, real FOIR-based amounts, real
 * rates for Poonawala/Tata Capital (Unity's is an explicit placeholder) — see that service's own
 * doc comments. Every answer id is prefixed `pl` so it can never collide with an identically-named
 * step elsewhere in the combined flow array.
 */
function isPersonalLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Personal Loan';
}

/** Personal Loan's real lender eligibility rules (Poonawalla/Tata Capital/Unity) only apply to
 * salaried applicants — a business owner/self-employed professional isn't a case any of these
 * gates were ever built for (2026-10-21 instruction). The `product` step's own options already
 * hide "Personal Loan" for them (see homeLoan.ts's productOptionsFor), so this is only the
 * defensive backstop for the branch being reached some other way — same "stop here, give a
 * dedicated reason" treatment as Business Loan gets for a salaried applicant. */
function isNonSalariedSegment(ctx: StepContext): boolean {
  return Boolean(ctx.answers.segment) && ctx.answers.segment !== 'Salaried';
}

/** A single, fixed requested tenure for the eligibility pre-check — chosen because it fits every
 * lender's real range regardless of income tier (Poonawala: 12–36 or 12–60 depending on income;
 * Tata Capital: 12–72; Unity: 24–36). This flow never asks the customer their preferred tenure, so
 * there's no real value to send instead. */
const PL_PRECHECK_TENURE_MONTHS = 36;

/** Stands in for the optional bureau-depth facts the pre-check's gates can check (DPD history,
 * credit enquiries, overdue amounts, bureau vintage, etc. — see that project's ApplicantFacts) but
 * that nothing in this chatbot can actually supply yet: there's no real CIBIL pull on UAT (see
 * FINFINITY_BUREAU_MOCK_OVERRIDE in config/env.ts), so these stay a clean, no-red-flags DUMMY
 * profile until a real bureau pull exists in prod — swap this out for the real values the moment
 * it does, rather than removing it (the pre-check gates still need *something* for these, real or
 * not, or they fall back to "not checked" warnings instead of actually running). */
const DUMMY_BUREAU_DEPTH_FACTS = {
  bureauVintageMonths: 36,
  isNewToCredit: false,
  monthsAtCurrentEmployer: 24,
  hasDerogatoryFlag: false,
  hasWriteOffOrSettlementLast12m: false,
  isUnderRestructuring: false,
  dpd30PlusRecent: false,
  dpd60PlusRecent: false,
  dpd90PlusRecent: false,
  overdueAmount: 0,
  overdueAmountNonCreditCard: 0,
  overdueAmountCreditCard: 0,
  enquiries7d: 0,
  enquiries30d: 0,
  enquiries90d: 0,
  activePlBlLoansLast6Months: 0,
  hasRestrictedProductExposure: false,
  dpdAnyInLast6Months: false,
  enquiries1d: 0,
  liveUnsecuredLoansOver1Lac: 0,
  // Unity-specific (its 2026-10-09 policy rewrite) — satisfies its "≥4 tradelines, one over ₹1
  // lakh" rule via the tradeline path (hasQualifyingCreditCard left false, since only one path
  // needs to be true).
  tradelineCount: 4,
  hasTradelineOverOneLakh: true,
  hasQualifyingCreditCard: false,
  hasSuitFiled: false,
} as const;

/** Standard annuity EMI — the pre-check service returns a rate/amount, never an EMI, so this flow
 * computes its own from them, same formula every other mock/real offer in this codebase already
 * uses (see mockOffers.ts). */
function computeEmi(principalRupees: number, ratePercent: number, tenureMonths: number): number {
  const r = ratePercent / 100 / 12;
  if (r <= 0 || principalRupees <= 0) return Math.round(principalRupees / tenureMonths);
  return Math.round((principalRupees * r * Math.pow(1 + r, tenureMonths)) / (Math.pow(1 + r, tenureMonths) - 1));
}

function buildPrecheckFacts(ctx: StepContext): PlEligibilityFacts {
  return {
    cibilScore: Number(ctx.answers.creditScore) || 0,
    monthlyIncome: Number(ctx.answers.plIncome),
    employmentType: mapSegmentToEmploymentType(ctx.answers.segment as string | undefined),
    age: ctx.answers.dob ? calcAge(ctx.answers.dob as string) : 0,
    pincode: (ctx.answers.pincode as string) ?? '',
    loanAmountRequested: Number(ctx.answers.plLoanAmount),
    tenureMonths: PL_PRECHECK_TENURE_MONTHS,
    existingMonthlyEmi: Number(ctx.answers.plEmi) || 0,
    // proposedMonthlyEmi deliberately omitted — it would need this lender's own EMI, which doesn't
    // exist until AFTER this same call tells us the amount (chicken/egg); defaults to 0 on the
    // pre-check side, which understates FOIR slightly. Acceptable for now, same "dummy until real
    // CIBIL exists" spirit as the bureau-depth facts below.
    ...DUMMY_BUREAU_DEPTH_FACTS,
  };
}

/** Runs our own standalone pre-check BRE for every lender IT knows about — one batched call
 * (2026-10-27, was one HTTP round-trip per lender, driven by a hardcoded list on our side; see
 * PersonalLoanEligibilityService.checkAll's own doc comment) — keeping EVERY lender's outcome,
 * eligible or not, with its own `reasons` from the pre-check service's response (that service
 * already returns these correctly; this used to be the only place they got thrown away, by
 * filtering ineligible lenders out before anything downstream ever saw them — 2026-10-24). Used
 * both as the actual customer-facing path (when the real financer chain is off, via
 * computeOwnBreOffers below) and, when it's on, as the shadow-mode comparison's own-BRE side
 * (runOwnBreComparison) — one set of calls serves both. */
async function checkAllLendersOwnBre(facts: PlEligibilityFacts): Promise<PlLenderComparisonResult[]> {
  const results = await personalLoanEligibilityService.checkAll(facts);
  return results.map((result): PlLenderComparisonResult => {
    const eligible = result.eligible && result.maxEligibleAmount !== undefined && result.estimatedRatePercent !== undefined && Boolean(result.maxTenureMonths);
    return {
      lender: LENDER_DISPLAY_NAME[result.lender] ?? result.lender,
      eligible,
      reasons: result.reasons,
      amountLakh: eligible ? Number((result.maxEligibleAmount! / 100_000).toFixed(2)) : undefined,
      rate: eligible ? String(result.estimatedRatePercent) : undefined,
      tenureYears: eligible ? Math.round(result.maxTenureMonths! / 12) : undefined,
      raw: result,
    };
  });
}

/** Customer-facing shape — eligible lenders only, mapped to LenderOffer with a real EMI computed
 * (the pre-check service never returns one). Derived from checkAllLendersOwnBre's full results
 * rather than making its own set of calls, so this and the shadow-mode comparison never diverge or
 * double-hit the pre-check service for the same customer. */
async function computeOwnBreOffers(facts: PlEligibilityFacts): Promise<LenderOffer[]> {
  const full = await checkAllLendersOwnBre(facts);
  return full
    .filter((r) => r.eligible)
    .map((r) => ({
      name: r.lender,
      amountLakh: r.amountLakh!,
      emi: computeEmi(r.amountLakh! * 100_000, Number(r.rate), r.tenureYears! * 12),
      rate: r.rate!,
      tenureYears: r.tenureYears!,
    }))
    .sort((a, b) => b.amountLakh - a.amountLakh);
}

/** Fired-and-forgotten (never awaited by the customer-facing path) whenever the real financer chain
 * computes offers — runs our own BRE on the exact same facts purely for comparison, and persists
 * both so they can be reviewed later to calibrate/improve our own BRE (2026-10-21 direct
 * instruction: "ur work is to make our personal BRE better and richer... dont change anything
 * without asking me"). Never shown to the customer, never affects what they see or which offers they
 * can pick — a read-only shadow run. Logs a simple richer-lender-count comparison so a quick grep of
 * `pl_bre_comparison` shows which engine found more eligible lenders for this profile without
 * needing to open the DB row.
 */
async function runOwnBreComparison(ctx: StepContext, leadId: string | undefined, realChainResults: PlLenderComparisonResult[]): Promise<void> {
  try {
    const facts = buildPrecheckFacts(ctx);
    const ownBreResults = await checkAllLendersOwnBre(facts);
    await prisma.plBreComparison.create({
      data: {
        conversationId: ctx.conversationId,
        leadId,
        facts: facts as unknown as Prisma.InputJsonValue,
        realChainResults: realChainResults as unknown as Prisma.InputJsonValue,
        ownBreResults: ownBreResults as unknown as Prisma.InputJsonValue,
      },
    });
    const realEligible = realChainResults.filter((r) => r.eligible);
    const ownEligible = ownBreResults.filter((r) => r.eligible);
    const matched = ownEligible.filter((own) => realEligible.some((real) => lenderNamesMatch(real.lender, own.lender)));
    // Agreement, now that both sides carry reasons: for every lender BOTH engines rejected, did
    // they at least land on a similar reason (any keyword overlap)? A single aggregate bool here —
    // the admin report below breaks this down per lender/row.
    const bothRejectedSameReason = ownBreResults.every((own) => {
      if (own.eligible) return true;
      const real = realChainResults.find((r) => lenderNamesMatch(r.lender, own.lender));
      if (!real || real.eligible) return true;
      return reasonsOverlap(own.reasons, real.reasons);
    });
    logger.info(
      {
        event: 'pl_bre_comparison',
        conversationId: ctx.conversationId,
        leadId,
        realChainLenderCount: realEligible.length,
        ownBreLenderCount: ownEligible.length,
        ownBreFoundMoreLenders: ownEligible.length > realEligible.length,
        ownBreHigherAmountForMatchedLenders: matched.some((own) => {
          const real = realEligible.find((r) => lenderNamesMatch(r.lender, own.lender));
          return real && (own.amountLakh ?? 0) > (real.amountLakh ?? 0);
        }),
        bothRejectedSameReason,
      },
      'personal loan BRE comparison saved',
    );
  } catch (err) {
    // Purely a comparison/calibration run — a failure here must never affect the customer-facing
    // flow, which has already returned its response by the time this runs.
    logger.error({ err, conversationId: ctx.conversationId }, 'pl BRE comparison run failed — continuing without it');
  }
}

/** Our 3 pre-check lenders ("Poonawala Fincorp", "Tata Capital", "Unity Small Finance Bank") vs the
 * real chain's own naming ("Poonawalla Fincorp Limited", "Tata Capital", "Unity Bank") — not
 * identical strings, so matched by their first word's leading characters rather than requiring an
 * exact match. A plain exact first-word match (the original version of this function) missed
 * "Poonawala" vs "Poonawalla" outright — single vs double 'l', caught by a test, 2026-10-24 — so
 * this compares only the first 6 characters, which both still share. Good enough for the comparison
 * report; not used for anything that needs to be precise. */
export function lenderNamesMatch(a: string, b: string): boolean {
  const firstPrefix = (s: string) => s.toLowerCase().split(/\s+/)[0]?.slice(0, 6);
  return Boolean(firstPrefix(a)) && firstPrefix(a) === firstPrefix(b);
}

/** Simple case-insensitive keyword overlap, not real NLP — "good enough to be indicative" per the
 * same spirit as lenderNamesMatch above, used by both the comparison log and the admin report. */
export function reasonsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length; // both empty = both silent = call it agreement
  const wordsA = new Set(a.join(' ').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = b.join(' ').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  return wordsB.some((w) => wordsA.has(w));
}

export const personalLoanSteps: StepDefinition[] = [
  {
    // Only asked as a fallback — gender normally already comes from the PAN lookup/dedupe match
    // (see pan.service.ts/dedupe.service.ts), same as name/DOB.
    id: 'plGender',
    type: 'choice',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx) && !ctx.answers.gender,
    botMessage: () => "What's your gender?",
    input: () => ({ type: 'choice', options: ['Male', 'Female', 'Other'], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'plGender', ['Male', 'Female', 'Other'], value, 'Is that male, female, or other?'),
    onAnswer: (parsed) => ({ gender: parsed }),
  },
  {
    id: 'plLoanAmount',
    type: 'number',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx),
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 500000, or 5 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 10_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 500000.' };
      if (v > MAX_SANE_LOAN_AMOUNT) return { ok: false, error: `That doesn't look right — enter the loan amount you need (up to ₹${(MAX_SANE_LOAN_AMOUNT / 10000000).toFixed(0)} crore).` };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plIncome',
    type: 'number',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx),
    botMessage: () => "What's your monthly income?",
    hint: () => 'Net take-home, or average monthly income if self-employed.',
    input: () => ({ type: 'number', placeholder: 'e.g. 60000' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 5_000) return { ok: false, error: 'Enter your actual monthly income — e.g. 60000.' };
      if (v > MAX_SANE_MONTHLY_AMOUNT) return { ok: false, error: `That doesn't look right — enter your actual monthly income (up to ₹${MAX_SANE_MONTHLY_AMOUNT.toLocaleString('en-IN')}).` };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plEmi',
    type: 'number',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx),
    botMessage: () => 'Do you currently have any other loan EMIs?',
    hint: () => 'Say "no" if you don\'t have any.',
    input: () => ({ type: 'number', placeholder: "e.g. 8000, or 'no'" }),
    validate: (value) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: "Enter the amount, or say 'no' if you don't have any." };
      if (v > MAX_SANE_MONTHLY_AMOUNT) return { ok: false, error: `That doesn't look right — enter your EMI amount (up to ₹${MAX_SANE_MONTHLY_AMOUNT.toLocaleString('en-IN')}).` };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'plEmployer',
    type: 'text',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx),
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
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx) && ctx.answers.plEmployer === EMPLOYER_OTHER,
    botMessage: () => "What's the name of your employer?",
    input: () => ({ type: 'text', placeholder: 'Employer name' }),
    validate: (value) => {
      const v = (value || '').trim();
      if (v.length < 2) return { ok: false, error: "Enter your employer's name." };
      return { ok: true, parsed: v };
    },
  },
  {
    // Only fires when the real financer chain is switched on (2026-10-21, off by default —
    // PL_REAL_FINANCER_CHAIN_ENABLED). That chain's financerwiseeligibility call needs an
    // already-created lead, unlike the pre-check-microservice path below (plCreateLead), which
    // doesn't need one until after eligibility is already shown. Same "create the lead the moment
    // we can" pattern as Business/Gold Loan, just gated behind this specific flag so the existing
    // (default) path's lead-creation timing is completely unaffected.
    id: 'plCreateLeadEarly',
    type: 'apiFetch',
    progressLabel: 'Personal Loan',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx) && env.PL_REAL_FINANCER_CHAIN_ENABLED && !ctx.answers.plLeadResult,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx): Promise<{ plLeadResult: LeadSyncResult }> => {
      const plLeadResult = await leadService.createLead({
        conversationId: ctx.conversationId,
        panMasked: maskPan(ctx.answers.pan as string),
        name: ctx.answers.name as string | undefined,
        mobileMasked: ctx.answers.mobile as string | undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        product: 'Personal Loan',
        loanType: 'Personal Loan',
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      return { plLeadResult };
    },
  },
  {
    id: 'plOffers',
    type: 'apiFetch',
    progressLabel: 'Your offers',
    isApplicable: (ctx) => isPersonalLoan(ctx) && !isNonSalariedSegment(ctx),
    botMessage: (ctx) => {
      const offers = ctx.answers.plOffers as { name: string; amountLakh: number }[] | undefined;
      if (!offers?.length) return "Here's what we found.";
      return `Good news — based on what you've shared, you're looking at offers upto <strong>₹${offers[0].amountLakh} lakh</strong>.`;
    },
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx) => {
      // Real financer chain (2026-10-21 — switched ON as the active path; see plCreateLeadEarly
      // above, which guarantees a lead already exists here when this is on) — ONE call covers every
      // lender, replacing the pre-check microservice's one-call-per-lender loop as what the customer
      // actually sees. Our own BRE still runs too, just silently in the background purely to compare
      // against the real one (runOwnBreComparison) — never awaited, never affects this response.
      if (env.PL_REAL_FINANCER_CHAIN_ENABLED) {
        const leadResult = ctx.answers.plLeadResult as LeadSyncResult | undefined;
        if (!leadResult?.builderLeadId) throw new Error('personalLoan: PL_REAL_FINANCER_CHAIN_ENABLED but plCreateLeadEarly produced no lead id');
        const result = await personalLoanFinancerService.getEligibility({
          customerId: Number(ctx.answers.remoteCustomerId),
          leadId: leadResult.builderLeadId,
          monthlyIncome: Number(ctx.answers.plIncome),
          obligation: Number(ctx.answers.plEmi) || 0,
          bureauScore: Number(ctx.answers.creditScore) || 0,
          token: ctx.answers.finfinityAccessToken as string | undefined,
        });
        runOwnBreComparison(ctx, leadResult.builderLeadId, result.fullResults);
        return { plOffers: result.offers, plFinancerRawByLender: result.rawByLender };
      }

      const offers = await computeOwnBreOffers(buildPrecheckFacts(ctx));
      return { plOffers: offers };
    },
  },
  {
    // Separate apiFetch step (shows a loading state) for the real Finfinity lead-creation call —
    // same pattern as homeLoan.ts's triggerOtpDedupe. Fires the MOMENT eligibility is shown (the
    // customer doesn't need to pick an offer first), unlike Gold Loan's deferred-to-submit-click
    // design — PL's lead creation doesn't attach a specific lender the way Gold's
    // setmuthootlenderoffer does, so there's no "one lead per lender" constraint to defer around
    // (2026-10-16 direct instruction: "create the lead the moment the eligibility is shown").
    id: 'plCreateLead',
    type: 'apiFetch',
    progressLabel: 'Your eligibility',
    // Skipped when the real financer chain already created the lead early (plCreateLeadEarly,
    // off by default) — this step existing is the default path's own "create the lead the moment
    // eligibility is shown" behavior, unaffected either way.
    isApplicable: (ctx) =>
      isPersonalLoan(ctx) && !isNonSalariedSegment(ctx) && !ctx.answers.plLeadResult && ((ctx.answers.plOffers as unknown[] | undefined)?.length ?? 0) > 0,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx): Promise<{ plLeadResult: LeadSyncResult }> => {
      const plLeadResult = await leadService.createLead({
        conversationId: ctx.conversationId,
        panMasked: maskPan(ctx.answers.pan as string),
        name: ctx.answers.name as string | undefined,
        mobileMasked: ctx.answers.mobile as string | undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        product: 'Personal Loan',
        loanType: 'Personal Loan',
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      return { plLeadResult };
    },
  },
  {
    id: 'plResult',
    type: 'result',
    progressLabel: 'Your eligibility',
    isApplicable: isPersonalLoan,
    botMessage: (ctx) => {
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (payload?.segmentNotSupported) return "Personal Loan isn't available for business owners or self-employed professionals — it's only for salaried applicants.";
      if (!payload?.eligible) return 'All done.';
      return 'Pick an offer below to proceed.';
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload } => {
      if (isNonSalariedSegment(ctx)) {
        return {
          resultPayload: {
            eligible: false,
            segmentNotSupported: true,
            name: ctx.answers.name as string | undefined,
            product: 'Personal Loan',
            loanType: 'Personal Loan',
            segment: ctx.answers.segment as EligibilityResultPayload['segment'],
            creditScore: ctx.answers.creditScore as number | undefined,
            rm: pickRm((ctx.answers.pan as string) || (ctx.answers.mobile as string) || ctx.conversationId),
            leadCreated: false,
          },
        };
      }
      const offers = (ctx.answers.plOffers as EligibilityResultPayload['offers']) ?? [];
      const lead = ctx.answers.plLeadResult as LeadSyncResult | undefined;
      const seedKey = (ctx.answers.pan as string) || (ctx.answers.mobile as string) || ctx.conversationId;
      const resultPayload: EligibilityResultPayload = {
        eligible: offers.length > 0,
        name: ctx.answers.name as string | undefined,
        product: 'Personal Loan',
        loanType: 'Personal Loan',
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        financialEligibilityLakh: offers[0]?.amountLakh,
        offers,
        // Falls back to the placeholder RM only when running on the mock lead service (no real API
        // configured) or when ineligible (plCreateLead never ran) — the real service always returns
        // a real RM (see lead.service.ts's PRODUCT_CODE 'PL' entry).
        rm: lead?.rm ?? pickRm(seedKey),
        leadId: lead?.builderLeadId ?? undefined,
        leadCreated: lead?.status === 'synced',
      };
      return { resultPayload };
    },
  },
];
