import type { RateTier, LenderDecisionData } from './types.js';

/**
 * Bajaj Housing Finance — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Rate table has
 * the same 6-cibil-band shape repeated across 4 income brackets for each employment type — the
 * no-file ("0"/"-1") rows are always priced identically to the (730,750] band in every single
 * bracket, a real pattern in the source, not an assumption made here.
 *
 * Two self-employed rate values (75000–200000 and >=200000 brackets, "(750,789]" band) appear in the
 * source as the literal float `7.8999999999999995` — a floating-point artifact of however the
 * source spreadsheet computed it, not a real distinct rate from 7.9. Stored here as 7.9.
 */
function bajajBand(income: RateTier['income'], a: number, b: number, c: number, d: number, e: number, f: number, employment: 'salaried' | 'self_employed'): RateTier[] {
  return [
    { employment, income, cibil: [{ cmp: 'gt', value: 300 }, { cmp: 'lte', value: 700 }], ratePercent: a },
    { employment, income, cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 730 }], ratePercent: b },
    { employment, income, cibil: [{ cmp: 'gt', value: 730 }, { cmp: 'lte', value: 750 }], ratePercent: c },
    { employment, income, noFile: true, ratePercent: c },
    { employment, income, cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 789 }], ratePercent: d },
    { employment, income, cibil: [{ cmp: 'gt', value: 789 }, { cmp: 'lte', value: 825 }], ratePercent: e },
    { employment, income, cibil: [{ cmp: 'gt', value: 825 }], ratePercent: f },
  ];
}

export const BAJAJ_HOUSING_FINANCE: LenderDecisionData = {
  displayName: 'Bajaj Housing Finance',
  repoLinked: false,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 22, self_employed: 22 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 35_000 }, self_employed: { cmp: 'gte', value: 50_000 } },
  loanAmount: {
    salaried: { min: 2_500_000, max: 100_000_000 },
    self_employed: { min: 2_500_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 150_000 }], foirCapPercent: 75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 150_000 }], foirCapPercent: 80 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 1 },
  ],
  rateTiers: [
    ...bajajBand([{ cmp: 'lt', value: 30_000 }], 9.15, 8.65, 8.4, 8.1, 7.95, 7.95, 'salaried'),
    ...bajajBand([{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 75_000 }], 9.15, 8.65, 8.4, 8.1, 7.95, 7.95, 'salaried'),
    ...bajajBand([{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 200_000 }], 8.9, 8.4, 8.15, 7.9, 7.8, 7.8, 'salaried'),
    ...bajajBand([{ cmp: 'gte', value: 200_000 }], 8.8, 8.35, 8.05, 7.8, 7.75, 7.5, 'salaried'),
    ...bajajBand([{ cmp: 'lt', value: 30_000 }], 9.25, 8.75, 8.5, 8.2, 8.05, 8.05, 'self_employed'),
    ...bajajBand([{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 75_000 }], 9.25, 8.75, 8.5, 8.2, 8.05, 8.05, 'self_employed'),
    ...bajajBand([{ cmp: 'gte', value: 75_000 }, { cmp: 'lt', value: 200_000 }], 9.0, 8.5, 8.25, 8.0, 7.9, 7.9, 'self_employed'),
    ...bajajBand([{ cmp: 'gte', value: 200_000 }], 8.9, 8.45, 8.15, 7.9, 7.85, 7.5, 'self_employed'),
  ],
};
