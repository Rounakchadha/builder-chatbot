import type { LenderDecisionData } from './types.js';

/**
 * ICICI Bank Ltd (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Distinct
 * from ICICI_HFC (ICICI Home Finance Company) below, which is a separate real entity in the same
 * source with its own completely different numbers.
 */
export const ICICI_BANK_HL: LenderDecisionData = {
  displayName: 'ICICI Bank Ltd',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 75 },
  minCibil: { salaried: 720, self_employed: 720 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 50_000 }, self_employed: { cmp: 'gt', value: 16_667 } },
  loanAmount: {
    salaried: { min: 1_500_000, max: 100_000_000 },
    self_employed: { min: 1_500_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 100_000 }], foirCapPercent: 50 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }], foirCapPercent: 70 },
    { employment: 'self_employed', foirCapPercent: 70 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 6_000 },
    { employment: 'self_employed', type: 'percent', value: 0.25 },
  ],
  rateTiers: [
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 7.8 },
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 779 }, { cmp: 'lte', value: 800 }], ratePercent: 8 },
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 779 }], ratePercent: 8.05 },
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 730 }, { cmp: 'lte', value: 750 }], ratePercent: 8.4 },
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 730 }], ratePercent: 8.6 },
    { employment: 'salaried', cibil: [{ cmp: 'lt', value: 700 }], ratePercent: 8.6 },
    { employment: 'salaried', noFile: true, ratePercent: 8.4 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 7.85 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 779 }, { cmp: 'lte', value: 800 }], ratePercent: 8.1 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 779 }], ratePercent: 8.15 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 730 }, { cmp: 'lte', value: 750 }], ratePercent: 8.6 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 730 }], ratePercent: 8.8 },
    { employment: 'self_employed', cibil: [{ cmp: 'lt', value: 700 }], ratePercent: 8.8 },
    { employment: 'self_employed', noFile: true, ratePercent: 8.6 },
  ],
};
