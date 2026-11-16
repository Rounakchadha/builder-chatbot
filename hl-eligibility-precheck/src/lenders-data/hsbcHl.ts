import type { LenderDecisionData } from './types.js';

/** HSBC (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. Another high
 * minimum ticket size (₹1 crore minimum loan) like DBS — real premium-banking positioning, not a
 * transcription error. The source literally writes the Self Employed processing fee as "₹0.10%" (a
 * rupee symbol in front of a percentage) — read here as 0.10%, a data-entry quirk in the source
 * spreadsheet, not a flat ₹0.10 fee. Rate is flat 7.5% for both employment types, no split at all. */
export const HSBC_HL: LenderDecisionData = {
  displayName: 'HSBC',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 65, self_employed: 70 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 50_000 }, self_employed: { cmp: 'gt', value: 62_500 } },
  loanAmount: {
    salaried: { min: 10_000_000, max: 100_000_000 },
    self_employed: { min: 10_000_000, max: 100_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', income: [{ cmp: 'lt', value: 250_000 }], foirCapPercent: 70 },
    { employment: 'salaried', income: [{ cmp: 'gte', value: 250_000 }], foirCapPercent: 75 },
    { employment: 'self_employed', foirCapPercent: 70 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.10 },
  ],
  rateTiers: [{ ratePercent: 7.5 }],
};
