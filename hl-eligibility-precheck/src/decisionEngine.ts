import { GateChecker, foir, computeAffordableAmount, roundDownToMultipleOf12, getLtvCapPercent } from './gates.js';
import { condsHold } from './lenders-data/types.js';
import type { Employment, LenderDecisionData } from './lenders-data/types.js';
import type { ApplicantFacts, LenderCode, LenderEligibilityResult } from './types.js';

function toEmployment(e: ApplicantFacts['employmentType']): Employment {
  // No real DMN table distinguishes a third "business_owner" bucket — see types.ts's EmploymentType
  // comment. Treated as self_employed, the closer of the two real buckets.
  return e === 'salaried' ? 'salaried' : 'self_employed';
}

/**
 * Credit-behavior rules (overdue/DPD/settlement/suit-filed/inquiries), confirmed 2026-11-02 — a
 * SEPARATE table from the per-lender common_parameter/FOIR/rate data above, shared across two
 * groups of lenders rather than varying lender-by-lender. Every one of this service's 21 lenders
 * falls into exactly one group (see each lender's own `creditBehaviorGroup`); a 22nd lender in the
 * source table, Kotak Bank, is Group A but still isn't buildable here at all for lack of its own
 * age/CIBIL/income/FOIR/rate data (see types.ts's LenderCode comment).
 *
 * Every fact here is optional and `requireIfKnown`-gated, same discipline as every other optional
 * fact in this service — a caller who hasn't supplied one of these gets a warning, not a silent
 * pass, and a lender's full credit-behavior picture can be built up incrementally as more of these
 * facts become available from a real bureau pull.
 */
function applyCreditBehaviorGates(g: GateChecker, data: LenderDecisionData, facts: ApplicantFacts): void {
  g.requireIfKnown(
    data.creditBehaviorGroup === 'A' ? facts.hasOverdueOnActiveLoan : facts.hasOverdueOnActiveLoanExclAgriKccGl,
    data.creditBehaviorGroup === 'A'
      ? 'Must have no overdue amount on any active loan'
      : 'Must have no overdue amount on any active loan (Agri/KCC/Gold Loan excluded)',
    (v) => v === false,
  );

  g.requireIfKnown(facts.dpd90PlusLast24Months, 'Must never have been 90+ days past due in the last 24 months', (v) => v === false);

  if (data.creditBehaviorGroup === 'A') {
    g.requireIfKnown(
      facts.dpd30PlusLast12MonthsExclCcAndSmallOs,
      'Must never have been 30+ days past due in the last 12 months (credit cards and outstanding under ₹10,000 excluded)',
      (v) => v === false,
    );
    g.requireIfKnown(facts.dpdAnyInLast15Days, 'Must have no days-past-due at all in the last 15 days', (v) => v === false);
    g.requireIfKnown(facts.dpdOccurrencesLast6Months, 'Must not have more than 3 days-past-due occurrences in the last 6 months', (v) => v <= 3);
    g.requireIfKnown(
      facts.hasDisqualifyingSettlementOrWriteOffGroupA,
      'Must have no settlement/write-off over ₹10,000 reported in the last 24 months (Home Loan/LAP/Auto Loan/Personal Loan settled over 10 years ago, or a Credit Card settled over 3 years ago, excluded)',
      (v) => v === false,
    );
    g.requireIfKnown(facts.inquiriesLast6MonthsForHl, 'Must not have more than 5 Home Loan bureau inquiries in the last 6 months', (v) => v <= 5);
  } else {
    g.requireIfKnown(
      facts.dpd30PlusLast6MonthsExclAgriKccGlCcAndSmallOs,
      'Must never have been 30+ days past due in the last 6 months (Agri/KCC/Gold Loan, credit cards, and outstanding under ₹10,000 excluded)',
      (v) => v === false,
    );
    g.requireIfKnown(facts.dpdOccurrencesLast3Months, 'Must not have more than 3 days-past-due occurrences in the last 3 months', (v) => v <= 3);
    g.requireIfKnown(
      facts.hasDisqualifyingSettlementOrWriteOffGroupB,
      'Must have no settlement/write-off over ₹25,000 reported in the last 12 months (Home Loan/LAP/Auto Loan/Personal Loan settled over 10 years ago, or a Credit Card settled over 3 years ago, excluded)',
      (v) => v === false,
    );
    g.requireIfKnown(facts.inquiriesLast6MonthsForHl, 'Must not have more than 10 Home Loan bureau inquiries in the last 6 months', (v) => v <= 10);
  }

  g.requireIfKnown(facts.hasSuitFiledOrWillfulDefaulter, 'Must not currently be reported as suit-filed or a willful defaulter', (v) => v === false);
}

/**
 * One generic evaluator reads every lender's transcribed DMN data instead of 21 hand-written
 * imperative gate files — see lenders-data/types.ts for why. Every `reasons`/`warnings` string still
 * names the real gate that failed, same as every pl-eligibility-precheck lender file.
 */
export function evaluateLender(code: LenderCode, data: LenderDecisionData, facts: ApplicantFacts): LenderEligibilityResult {
  const g = new GateChecker();
  const emp = toEmployment(facts.employmentType);

  const ageGreaterThan = data.ageGreaterThan[emp];
  const minCibil = data.minCibil[emp];
  const minIncome = data.minIncome[emp];
  const loanAmount = data.loanAmount[emp];

  if (ageGreaterThan === undefined || minIncome === undefined || loanAmount === undefined) {
    return {
      lender: code,
      eligible: false,
      reasons: [`No published ${data.displayName} policy covers ${emp === 'salaried' ? 'Salaried' : 'Self Employed'} applicants in the source DMN`],
      warnings: [],
    };
  }

  g.require(facts.age > ageGreaterThan, `Age must be greater than ${ageGreaterThan}`);

  const retirementAge = data.retirementAge[emp];
  const ageAtMaturity = facts.age + facts.tenureMonths / 12;
  g.require(ageAtMaturity <= retirementAge, `Age at loan maturity must not exceed ${retirementAge} (this lender's ${emp === 'salaried' ? 'salaried' : 'non-salaried'} retirement age)`);

  if (data.requireNoFile[emp]) {
    g.require(facts.cibilScore <= 0, `This lender's DMN only defines acceptance for ${emp === 'salaried' ? 'Salaried' : 'Self Employed'} applicants with no bureau file at all`);
  } else if (minCibil !== undefined) {
    const noFileOk = data.noFileAccepted[emp] !== false && facts.cibilScore <= 0;
    g.require(facts.cibilScore >= minCibil || noFileOk, `CIBIL score must be at least ${minCibil}${data.noFileAccepted[emp] !== false ? ', or no bureau file at all' : ''}`);
  }

  const incomeCmpWord = minIncome.cmp === 'gte' ? 'at least' : 'greater than';
  g.require(condsHold(facts.monthlyIncome, [minIncome]), `Monthly income must be ${incomeCmpWord} ₹${minIncome.value.toLocaleString('en-IN')}`);

  const foirTier = data.foirTiers.find((t) => t.employment === emp && condsHold(facts.monthlyIncome, t.income));
  if (foirTier) {
    g.require(foir(facts) * 100 <= foirTier.foirCapPercent, `FOIR (existing + proposed EMI vs. income) must not exceed ${foirTier.foirCapPercent}%`);
  } else {
    g.warnings.push('Not checked (no matching FOIR tier found in the source DMN for this income level)');
  }

  // Matches pl-eligibility-precheck's standing "never reject on requested amount" rule
  // (2026-10-15 instruction) — the customer's requested amount never gates eligibility here either;
  // the REPORTED max is still clamped to this lender's real min/max loan amount below.

  applyCreditBehaviorGates(g, data, facts);

  if (!g.eligible) return { lender: code, eligible: false, reasons: g.reasons, warnings: g.warnings };

  // A no-file applicant (cibilScore <= 0, a sentinel, not a real score) must only ever match a row
  // explicitly marked noFile, or a row with no cibil condition at all (e.g. IIFL's single flat-rate
  // row) — never a numeric cibil band like `cibil < 730`, which the -1/0 sentinel would otherwise
  // satisfy by pure arithmetic accident, silently pricing a no-file applicant off a scored band that
  // was never meant to cover them (caught before shipping, same discipline as the PL service's
  // isEffectivelyNewToCredit bug).
  const rateTier = data.rateTiers.find((t) => {
    if (t.employment !== undefined && t.employment !== emp) return false;
    if (!condsHold(facts.monthlyIncome, t.income)) return false;
    if (facts.cibilScore <= 0) return t.noFile === true || t.cibil === undefined;
    return !t.noFile && condsHold(facts.cibilScore, t.cibil);
  });
  if (!rateTier) {
    return {
      lender: code,
      eligible: false,
      reasons: ['No matching rate tier found in the source DMN for this income/CIBIL combination'],
      warnings: g.warnings,
    };
  }

  const feeTier = data.processingFee.find((t) => t.employment === emp && condsHold(facts.monthlyIncome, t.income));

  return {
    lender: code,
    eligible: true,
    reasons: g.reasons,
    warnings: g.warnings,
    estimatedRatePercent: rateTier.ratePercent,
    maxEligibleAmount: foirTier
      ? computeAffordableAmount(
          foirTier.foirCapPercent / 100,
          facts,
          rateTier.ratePercent,
          loanAmount.max,
          loanAmount.min,
          getLtvCapPercent(facts.loanAmountRequested),
        )
      : undefined,
    processingFeePercentMin: feeTier?.type === 'percent' ? feeTier.value : undefined,
    processingFeeFlatRupees: feeTier?.type === 'flat_rupees' ? feeTier.value : undefined,
    maxTenureMonths: roundDownToMultipleOf12(Math.max(0, (retirementAge - facts.age) * 12)),
  };
}
