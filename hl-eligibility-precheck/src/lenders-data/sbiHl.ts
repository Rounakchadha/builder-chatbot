import type { LenderDecisionData } from './types.js';

/**
 * State Bank of India (Home Loan) — source: HL_BRE.zip (shared 2026-10-28). Salaried-only, confirmed
 * by the product owner 2026-10-28: SBI genuinely does not approve Self Employed Home Loan applicants
 * through this product. No Self Employed row exists anywhere across common_parameter, Income_Norms,
 * lender_foir, lender_loan_amount, or lender_rate for SBI. A Self Employed applicant is correctly
 * rejected by decisionEngine.ts's "no published policy" check before any gate runs.
 *
 * GAP, faithfully preserved: lender_rate has no row for a scored CIBIL between 551 and 649 (only
 * ">=650" and up, plus the no-file rows, are defined), even though common_parameter's own floor
 * (>550) would otherwise admit such an applicant — they correctly come back "no matching rate tier".
 */
export const SBI_HL: LenderDecisionData = {
  displayName: 'State Bank of India',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 550 },
  noFileAccepted: { salaried: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 10_000 } },
  loanAmount: {
    salaried: { min: 500_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 10_000 }], foirCapPercent: 20 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 10_000 }, { cmp: 'lt', value: 25_000 }], foirCapPercent: 30 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 25_000 }, { cmp: 'lt', value: 41_667 }], foirCapPercent: 55 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 41_667 }, { cmp: 'lt', value: 66_667 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 66_667 }, { cmp: 'lt', value: 83_333 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 83_333 }], foirCapPercent: 70 },
  ],
  processingFee: [{ employment: 'salaried', type: 'flat_rupees', value: 7_500 }],
  rateTiers: [
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 650 }, { cmp: 'lt', value: 700 }], ratePercent: 8.5 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 700 }, { cmp: 'lt', value: 750 }], ratePercent: 7.95 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 750 }, { cmp: 'lt', value: 780 }], ratePercent: 7.85 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 780 }, { cmp: 'lt', value: 825 }], ratePercent: 7.75 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 825 }], ratePercent: 7.5 },
    { employment: 'salaried', noFile: true, ratePercent: 8.15 },
  ],
};
