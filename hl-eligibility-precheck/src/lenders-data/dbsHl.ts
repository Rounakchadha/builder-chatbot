import type { LenderDecisionData } from './types.js';

/** DBS (Home Loan) — source: HL_BRE.zip (shared 2026-10-28), all real DMN rows. A genuinely high
 * minimum ticket size (₹1 crore minimum loan, ₹1 lakh minimum monthly income) in the source — not a
 * transcription error, this is DBS's real premium-banking-only Home Loan positioning. Rate is flat
 * 8.5% for both employment types, with no CIBIL split in the source at all. */
export const DBS_HL: LenderDecisionData = {
  displayName: 'DBS',
  repoLinked: true,
  creditBehaviorGroup: 'A',
  ageGreaterThan: { salaried: 21, self_employed: 21 },
  retirementAge: { salaried: 60, self_employed: 65 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 100_000 }, self_employed: { cmp: 'gt', value: 100_000 } },
  loanAmount: {
    salaried: { min: 10_000_000, max: 65_000_000 },
    self_employed: { min: 10_000_000, max: 65_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', foirCapPercent: 70 },
    { employment: 'self_employed', foirCapPercent: 65 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'flat_rupees', value: 10_000 },
  ],
  rateTiers: [{ ratePercent: 8.5 }],
};
