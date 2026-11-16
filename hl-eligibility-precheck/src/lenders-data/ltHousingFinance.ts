import type { RateTier, LenderDecisionData } from './types.js';

/**
 * L&T Housing Finance — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. No rate row
 * exists below CIBIL 650 (common_parameter's own floor is 650 anyway, so this never actually binds
 * once the CIBIL gate has already passed) — consistent with every other table, not a gap worth
 * flagging separately here.
 */
function ltBand(income: RateTier['income'], a: number, b: number, c: number, d: number, employment: 'salaried' | 'self_employed'): RateTier[] {
  return [
    { employment, income, cibil: [{ cmp: 'gte', value: 800 }], ratePercent: a },
    { employment, income, cibil: [{ cmp: 'lt', value: 800 }, { cmp: 'gte', value: 750 }], ratePercent: b },
    { employment, income, cibil: [{ cmp: 'lt', value: 750 }, { cmp: 'gte', value: 700 }], ratePercent: c },
    { employment, income, noFile: true, ratePercent: c },
    { employment, income, cibil: [{ cmp: 'lt', value: 700 }, { cmp: 'gte', value: 650 }], ratePercent: d },
  ];
}

export const LT_HOUSING_FINANCE: LenderDecisionData = {
  displayName: 'L&T Housing Finance',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 22, self_employed: 22 },
  retirementAge: { salaried: 65, self_employed: 70 },
  minCibil: { salaried: 650, self_employed: 650 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 30_000 }, self_employed: { cmp: 'gt', value: 20_833 } },
  loanAmount: {
    salaried: { min: 3_000_000, max: 75_000_000 },
    self_employed: { min: 3_000_000, max: 75_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 75_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 150_000 }], foirCapPercent: 75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 150_000 }], foirCapPercent: 80 },
    { employment: 'self_employed', foirCapPercent: 85 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.25 },
  ],
  rateTiers: [
    ...ltBand([{ cmp: 'lt', value: 75_000 }], 7.95, 8.2, 8.35, 8.9, 'salaried'),
    ...ltBand([{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 150_000 }], 7.8, 8.15, 8.3, 8.8, 'salaried'),
    ...ltBand([{ cmp: 'gte', value: 150_000 }, { cmp: 'lt', value: 200_000 }], 7.8, 8.0, 8.15, 8.65, 'salaried'),
    ...ltBand([{ cmp: 'gte', value: 200_000 }], 7.75, 7.95, 8.1, 8.6, 'salaried'),
    ...ltBand([{ cmp: 'lt', value: 75_000 }], 8.3, 8.5, 8.65, 8.3, 'self_employed'),
    ...ltBand([{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 150_000 }], 8.25, 8.45, 8.6, 9.1, 'self_employed'),
    ...ltBand([{ cmp: 'gte', value: 150_000 }, { cmp: 'lt', value: 200_000 }], 8.25, 8.3, 8.45, 9.85, 'self_employed'),
    ...ltBand([{ cmp: 'gte', value: 200_000 }], 8.3, 8.35, 8.5, 8.3, 'self_employed'),
  ],
};
