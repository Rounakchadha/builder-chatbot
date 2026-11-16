import type { LenderDecisionData } from './types.js';

/** PNB Housing — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Rate is tiered by
 * income only for Salaried (no CIBIL split in the source) and a single flat figure for Self
 * Employed. */
export const PNB_HOUSING: LenderDecisionData = {
  displayName: 'PNB Housing',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 21, self_employed: 23 },
  retirementAge: { salaried: 70, self_employed: 75 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 18_000 }, self_employed: { cmp: 'gt', value: 27_083 } },
  loanAmount: {
    salaried: { min: 2_000_000, max: 50_000_000 },
    self_employed: { min: 2_000_000, max: 50_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], foirCapPercent: 50 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 55 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 60 },
    { employment: 'self_employed', foirCapPercent: 90 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.50 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], ratePercent: 8.95 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], ratePercent: 8.8 },
    { employment: 'self_employed', ratePercent: 8.9 },
  ],
};
