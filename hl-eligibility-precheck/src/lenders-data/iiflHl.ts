import type { LenderDecisionData } from './types.js';

/**
 * IIFL (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. The rate table has
 * exactly one row, flat 9.5%, with no income or CIBIL split at all — genuinely flat in the source,
 * not a simplification made here. Since the row has no cibil condition, it correctly prices both
 * scored and no-bureau-file applicants identically (see decisionEngine.ts's no-file matching rule).
 */
export const IIFL_HL: LenderDecisionData = {
  displayName: 'IIFL',
  repoLinked: false,
  creditBehaviorGroup: 'B',
  // Common_parameter gives ">699" (salaried) / ">689" (self employed) — integer CIBIL scores, so
  // stored here as the equivalent inclusive floor (700 / 690).
  ageGreaterThan: { salaried: 22, self_employed: 22 },
  retirementAge: { salaried: 70, self_employed: 70 },
  minCibil: { salaried: 700, self_employed: 690 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 20_000 }, self_employed: { cmp: 'gt', value: 20_833 } },
  loanAmount: {
    salaried: { min: 2_000_000, max: 30_000_000 },
    self_employed: { min: 2_000_000, max: 30_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', foirCapPercent: 65 },
    { employment: 'self_employed', foirCapPercent: 100 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'percent', value: 0.50 },
    { employment: 'self_employed', type: 'percent', value: 0.50 },
  ],
  rateTiers: [{ ratePercent: 9.5 }],
};
