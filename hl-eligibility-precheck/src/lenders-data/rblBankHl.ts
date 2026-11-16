import type { LenderDecisionData } from './types.js';

/** RBL Bank (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Note the max
 * loan amount genuinely differs by employment type in the source (₹5cr salaried vs. ₹10cr self
 * employed) — not a transcription slip. */
export const RBL_BANK_HL: LenderDecisionData = {
  displayName: 'RBL Bank',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 23 },
  retirementAge: { salaried: 70, self_employed: 75 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 15_000 }, self_employed: { cmp: 'gt', value: 41_666 } },
  loanAmount: {
    salaried: { min: 3_000_000, max: 50_000_000 },
    self_employed: { min: 3_000_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 40_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 40_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 15_000 },
    { employment: 'self_employed', type: 'percent', value: 0.20 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 40_000 }], ratePercent: 8.95 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 40_000 }, { cmp: 'lt', value: 100_000 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], ratePercent: 8.8 },
    { employment: 'self_employed', ratePercent: 8.99 },
  ],
};
