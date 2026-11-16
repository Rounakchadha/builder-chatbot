import type { LenderDecisionData } from './types.js';

/** Axis Bank (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. */
export const AXIS_BANK_HL: LenderDecisionData = {
  displayName: 'Axis Bank',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 8_000 }, self_employed: { cmp: 'gt', value: 15_000 } },
  loanAmount: {
    salaried: { min: 100_000, max: 100_000_000 },
    self_employed: { min: 100_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 25_000 }], foirCapPercent: 50 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 25_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 20_000 }], foirCapPercent: 60 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 20_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 70 },
  ],
  processingFee: [
    // Source gives two rows (<=25000 and >=25000) both quoting the same ₹10,000 flat fee — merged
    // into one unconditional tier since the figure never actually varies by income here.
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.40 },
  ],
  rateTiers: [
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 7.7 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 780 }, { cmp: 'lt', value: 800 }], ratePercent: 7.7 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 750 }, { cmp: 'lt', value: 780 }], ratePercent: 7.8 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 750 }], ratePercent: 7.85 },
    { employment: 'salaried', noFile: true, ratePercent: 7.95 },
    { employment: 'salaried', cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 7.95 },
    { employment: 'self_employed', cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 7.8 },
    { employment: 'self_employed', cibil: [{ cmp: 'gte', value: 780 }, { cmp: 'lt', value: 800 }], ratePercent: 7.8 },
    { employment: 'self_employed', cibil: [{ cmp: 'gte', value: 750 }, { cmp: 'lt', value: 780 }], ratePercent: 7.9 },
    { employment: 'self_employed', cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 750 }], ratePercent: 7.95 },
    { employment: 'self_employed', noFile: true, ratePercent: 8.1 },
    { employment: 'self_employed', cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 8.1 },
  ],
};
