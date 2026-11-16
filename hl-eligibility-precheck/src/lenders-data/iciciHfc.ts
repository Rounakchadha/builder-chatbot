import type { LenderDecisionData } from './types.js';

/**
 * ICICI HFC (ICICI Home Finance Company) — source: HL_BRE.zip (shared 2026-10-28), all real DMN
 * rows. A separate real entity from ICICI Bank Ltd (see iciciBankHl.ts) with its own numbers.
 *
 * GAP, faithfully preserved: common_parameter's own CIBIL floor is 700 (inclusive), but the rate
 * table's bands only start at STRICTLY >700 — so a score of exactly 700 clears the eligibility gate
 * yet matches no rate band at all, correctly coming back "no matching rate tier" rather than being
 * assigned a guessed rate. The rate table's own "<675" band is consequently unreachable in practice
 * (the 700 floor already rejects anyone who'd fall in it) — real, if slightly redundant, DMN data,
 * kept as-is rather than silently pruned.
 */
export const ICICI_HFC: LenderDecisionData = {
  displayName: 'ICICI HFC',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 21, self_employed: 28 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 10_000 }, self_employed: { cmp: 'gt', value: 12_500 } },
  loanAmount: {
    salaried: { min: 1_000_000, max: 50_000_000 },
    self_employed: { min: 1_000_000, max: 50_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 30_000 }], foirCapPercent: 50 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 50_000 }], foirCapPercent: 60 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }], foirCapPercent: 70 },
    { employment: 'self_employed', foirCapPercent: 70 },
  ],
  processingFee: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 30_000 }], type: 'percent', value: 1.0 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 30_000 }, { cmp: 'lt', value: 50_000 }], type: 'percent', value: 0.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }], type: 'percent', value: 0.50 },
    { employment: 'self_employed', type: 'percent', value: 0.75 },
  ],
  rateTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 9.75 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 9.75 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 9.95 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], noFile: true, ratePercent: 10.2 },
    { employment: 'salaried', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 10.95 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], noFile: true, ratePercent: 9.65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 10.95 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 8.75 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 8.9 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], noFile: true, ratePercent: 9.65 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 10.95 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 10.05 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 10.05 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 10.3 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], noFile: true, ratePercent: 10.6 },
    { employment: 'self_employed', income: [{ cmp: 'lt', value: 50_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 11.1 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 8.85 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 8.85 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 9.05 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], noFile: true, ratePercent: 9.9 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 50_000 }, { cmp: 'lt', value: 100_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 11.1 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 800 }], ratePercent: 8.85 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 750 }, { cmp: 'lte', value: 800 }], ratePercent: 8.85 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'gt', value: 700 }, { cmp: 'lte', value: 750 }], ratePercent: 9.05 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], noFile: true, ratePercent: 9.9 },
    { employment: 'self_employed', income: [{ cmp: 'gte', value: 100_000 }], cibil: [{ cmp: 'lt', value: 675 }], ratePercent: 11.1 },
  ],
};
