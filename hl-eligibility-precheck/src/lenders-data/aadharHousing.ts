import type { LenderDecisionData } from './types.js';

/**
 * Aadhar Housing — source: HL_BRE.zip (shared 2026-10-28). The raw common_parameter rows only showed
 * one acceptance row per employment type (Salaried: "<1" no-file only; Self Employed: ">=650" scored
 * only) instead of the usual two (scored + no-file) each. Clarified with the product owner
 * 2026-10-28: NOT an employment-specific split at all — the two accepted CIBIL conditions (>=650
 * scored, OR no bureau file) both apply to BOTH employment types, same as every other lender in this
 * service. The sheet's employment-type labels on those two rows were incidental to how they were
 * entered, not a real distinction. No anomaly after all.
 */
export const AADHAR_HOUSING: LenderDecisionData = {
  displayName: 'Aadhar Housing',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 650, self_employed: 650 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 7_000 }, self_employed: { cmp: 'gt', value: 7_000 } },
  loanAmount: {
    salaried: { min: 100_000, max: 4_000_000 },
    self_employed: { min: 100_000, max: 4_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'gte', value: 7_000 }, { cmp: 'lt', value: 10_000 }], foirCapPercent: 45 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 10_000 }, { cmp: 'lt', value: 20_000 }], foirCapPercent: 50 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 20_000 }, { cmp: 'lt', value: 30_000 }], foirCapPercent: 55 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 60_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 60_000 }], foirCapPercent: 65 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 7_000 }, { cmp: 'lt', value: 10_000 }], foirCapPercent: 45 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 10_000 }, { cmp: 'lt', value: 20_000 }], foirCapPercent: 50 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 20_000 }, { cmp: 'lt', value: 30_000 }], foirCapPercent: 55 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 60_000 }], foirCapPercent: 60 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 60_000 }], foirCapPercent: 65 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 1.5 },
    { employment: 'self_employed', type: 'percent', value: 1.5 },
  ],
  rateTiers: [
    { employment: 'salaried', ratePercent: 10.5 },
    { employment: 'self_employed', ratePercent: 12.5 },
  ],
};
