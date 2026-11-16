import type { LenderDecisionData } from './types.js';

/**
 * Federal Bank — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Rate table has no row
 * for a scored applicant between 1 and 650 (only "<1" no-file and ">650<=749" are defined below the
 * 750 band) — a real gap in the source, not an oversight here; such an applicant correctly comes
 * back "no matching rate tier" from decisionEngine.ts.
 */
export const FEDERAL_BANK_HL: LenderDecisionData = {
  displayName: 'Federal Bank',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 725, self_employed: 725 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 25_000 }, self_employed: { cmp: 'gt', value: 25_000 } },
  loanAmount: {
    salaried: { min: 5_000_000, max: 150_000_000 },
    self_employed: { min: 5_000_000, max: 150_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], foirCapPercent: 75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }, { cmp: 'lt', value: 300_000 }], foirCapPercent: 80 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 300_000 }], foirCapPercent: 85 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 200_000 }, { cmp: 'lt', value: 300_000 }], foirCapPercent: 80 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 300_000 }, { cmp: 'lt', value: 400_000 }], foirCapPercent: 85 },
    { employment: 'self_employed', income: [{ cmp: 'gt', value: 400_000 }], foirCapPercent: 90 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.25 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.5 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.5 },
    { employment: 'salaried', noFile: true, ratePercent: 7.75 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 8.5 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.9 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.65 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 200_000 }], cibil: [{ cmp: 'gt', value: 750 }], ratePercent: 7.65 },
    { employment: 'self_employed', noFile: true, ratePercent: 7.9 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 9 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 8.8 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 200_000 }], cibil: [{ cmp: 'gt', value: 650 }, { cmp: 'lte', value: 749 }], ratePercent: 8.65 },
  ],
};
