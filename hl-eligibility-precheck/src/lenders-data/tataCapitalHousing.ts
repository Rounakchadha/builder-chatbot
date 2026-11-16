import type { LenderDecisionData } from './types.js';

/**
 * Tata Capital Housing — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. A completely
 * separate entity from pl-eligibility-precheck's TATA_CAPITAL (Personal Loan) — different product,
 * different real policy, deliberately no numbers shared between the two files.
 */
export const TATA_CAPITAL_HOUSING: LenderDecisionData = {
  displayName: 'Tata Capital Housing',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 25, self_employed: 25 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 25_000 }, self_employed: { cmp: 'gt', value: 33_333 } },
  loanAmount: {
    salaried: { min: 3_500_000, max: 100_000_000 },
    self_employed: { min: 3_500_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], foirCapPercent: 55 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 75_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'self_employed', foirCapPercent: 80 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 0.50 },
    { employment: 'self_employed', type: 'percent', value: 0.50 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }], ratePercent: 8.75 },
    { employment: 'self_employed', ratePercent: 8.85 },
  ],
};
