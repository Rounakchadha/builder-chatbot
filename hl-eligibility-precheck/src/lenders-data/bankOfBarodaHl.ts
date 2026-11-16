import type { LenderDecisionData } from './types.js';

/** Bank of Baroda (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Above
 * ₹50,000 income, the source's rate rows apply to both employment types identically (the
 * employment_type column is "-"), so those tiers are stored here with no `employment` field. */
export const BANK_OF_BARODA_HL: LenderDecisionData = {
  displayName: 'Bank of Baroda',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 10_000 }, self_employed: { cmp: 'gt', value: 10_000 } },
  loanAmount: {
    salaried: { min: 500_000, max: 50_000_000 },
    self_employed: { min: 500_000, max: 50_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 25_000 }], foirCapPercent: 40 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 25_000 }, { cmp: 'lt', value: 50_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], foirCapPercent: 70 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }], foirCapPercent: 80 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 8_500 },
    { employment: 'self_employed', type: 'flat_rupees', value: 8_500 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 825 }], ratePercent: 7.9 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 800 }, { cmp: 'lt', value: 825 }], ratePercent: 7.9 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 771 }, { cmp: 'lt', value: 800 }], ratePercent: 7.9 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 751 }, { cmp: 'lt', value: 771 }], ratePercent: 8 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 726 }, { cmp: 'lt', value: 751 }], ratePercent: 8.15 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 701 }, { cmp: 'lt', value: 726 }], ratePercent: 8.25 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 1 }, { cmp: 'lt', value: 701 }], ratePercent: 8.95 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], noFile: true, ratePercent: 8.25 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 825 }], ratePercent: 8 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 800 }, { cmp: 'lt', value: 825 }], ratePercent: 8 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 771 }, { cmp: 'lt', value: 800 }], ratePercent: 8 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 751 }, { cmp: 'lt', value: 771 }], ratePercent: 8.1 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 726 }, { cmp: 'lt', value: 751 }], ratePercent: 8.25 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 701 }, { cmp: 'lt', value: 726 }], ratePercent: 8.35 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 1 }, { cmp: 'lt', value: 701 }], ratePercent: 8.95 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], noFile: true, ratePercent: 8.35 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 825 }], ratePercent: 7.5 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 800 }, { cmp: 'lt', value: 825 }], ratePercent: 7.55 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 771 }, { cmp: 'lt', value: 800 }], ratePercent: 7.65 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 751 }, { cmp: 'lt', value: 771 }], ratePercent: 7.65 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 726 }, { cmp: 'lt', value: 751 }], ratePercent: 7.95 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 701 }, { cmp: 'lt', value: 726 }], ratePercent: 7.95 },
    { income: [{ cmp: 'gt', value: 50_000 }], cibil: [{ cmp: 'gte', value: 1 }, { cmp: 'lt', value: 701 }], ratePercent: 9.15 },
    { income: [{ cmp: 'gt', value: 50_000 }], noFile: true, ratePercent: 8 },
  ],
};
