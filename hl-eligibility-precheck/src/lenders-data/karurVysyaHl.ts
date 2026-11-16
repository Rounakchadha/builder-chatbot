import type { LenderDecisionData } from './types.js';

/** Karur Vysya Bank (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Note
 * the CIBIL floor is dramatically higher for Self Employed (785) than Salaried (685) — a real,
 * unusually steep split in the source, not a transcription slip. Rate is flat per employment type,
 * no income/CIBIL tiering at all. */
export const KARUR_VYSYA_HL: LenderDecisionData = {
  displayName: 'Karur Vysya',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 23, self_employed: 23 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 685, self_employed: 785 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 40_000 }, self_employed: { cmp: 'gt', value: 40_000 } },
  loanAmount: {
    salaried: { min: 3_000_000, max: 250_000_000 },
    self_employed: { min: 3_000_000, max: 250_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 75_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 0.50 },
    { employment: 'self_employed', type: 'percent', value: 0.50 },
  ],
  rateTiers: [
    { employment: 'salaried', ratePercent: 8.9 },
    { employment: 'self_employed', ratePercent: 8.99 },
  ],
};
