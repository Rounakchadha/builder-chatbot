import type { LenderDecisionData } from './types.js';

/** Piramal Housing — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Rate is tiered by
 * income only for Salaried (no CIBIL split at all in the source) and a single flat figure for Self
 * Employed. */
export const PIRAMAL_HOUSING: LenderDecisionData = {
  displayName: 'Piramal Housing',
  repoLinked: true,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 22, self_employed: 22 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 650, self_employed: 650 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 12_000 }, self_employed: { cmp: 'gt', value: 20_000 } },
  loanAmount: {
    salaried: { min: 1_000_000, max: 40_000_000 },
    self_employed: { min: 1_000_000, max: 40_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 20_000 }], foirCapPercent: 55 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 20_000 }, { cmp: 'lt', value: 35_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 35_000 }, { cmp: 'lt', value: 50_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 1.0 },
    { employment: 'self_employed', type: 'percent', value: 1.0 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 20_000 }], ratePercent: 12.0 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 20_000 }, { cmp: 'lt', value: 35_000 }], ratePercent: 10.25 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 35_000 }, { cmp: 'lt', value: 100_000 }], ratePercent: 10.0 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], ratePercent: 9.75 },
    { employment: 'self_employed', ratePercent: 10.5 },
  ],
};
