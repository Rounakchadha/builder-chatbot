import type { LenderDecisionData } from './types.js';

/**
 * Aditya Birla Housing Finance — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows.
 *
 * NO-FILE PRICING, confirmed by the product owner 2026-10-28: a no-bureau-file applicant gets the
 * same rate as the `<730` scored band, per income bracket. Modeled below as its own explicit
 * `noFile: true` row per bracket (not inferred by letting the -1/0 sentinel arithmetically satisfy
 * `cibil < 730` — decisionEngine.ts deliberately never does that; see its rate-matching comment).
 */
export const ADITYA_BIRLA_HOUSING: LenderDecisionData = {
  displayName: 'Aditya Birla Housing Finance',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 70 },
  minCibil: { salaried: 675, self_employed: 675 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 15_000 }, self_employed: { cmp: 'gt', value: 15_000 } },
  loanAmount: {
    salaried: { min: 500_000, max: 30_000_000 },
    self_employed: { min: 500_000, max: 30_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 41_666 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 41_666 }, { cmp: 'lt', value: 100_000 }], foirCapPercent: 65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }, { cmp: 'lt', value: 200_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 200_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 0.25 },
    { employment: 'self_employed', type: 'percent', value: 0.40 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 800 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 8.5 },
    { employment: 'salaried', income: [{ cmp: 'lte', value: 100_000 }], noFile: true, ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 8.7 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 8.25 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 800 }], ratePercent: 8.5 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], noFile: true, ratePercent: 8.7 },
    { employment: 'self_employed', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 800 }], ratePercent: 8.9 },
    { employment: 'self_employed', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 9.3 },
    { employment: 'self_employed', income: [{ cmp: 'lte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 8.75 },
    { employment: 'self_employed', income: [{ cmp: 'lte', value: 100_000 }], noFile: true, ratePercent: 9.3 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 730 }, { cmp: 'lt', value: 800 }], ratePercent: 8.75 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 730 }], ratePercent: 9.0 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gte', value: 800 }], ratePercent: 8.7 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], noFile: true, ratePercent: 9.0 },
  ],
};
