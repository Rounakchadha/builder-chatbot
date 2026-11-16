import type { LenderDecisionData } from './types.js';

/**
 * Jio Credit Limited (Home Loan) — source: HL_BRE.zip (shared 2026-10-28).
 *
 * NAME: the lender's real name is "Jio Credit Limited" (lender_rate sheet). Every other sheet
 * (common_parameter, Income_Norms, for_age, lender_loan_amount, for_repo_rate) called it "Jio
 * Finance" instead — confirmed 2026-10-28 this was just inconsistent naming in the source, not two
 * different entities. Renamed everywhere in this service 2026-10-28 (was `JIO_FINANCE_HL` /
 * `jioFinanceHl.ts`) to the correct name.
 *
 * MALFORMED CELL: the Self Employed row for the top CIBIL band in lender_rate has its bureau_score
 * cell literally reading just `>` with no number after it (a real cut-off/corrupted cell in the
 * source spreadsheet, not a parsing mistake on this end). Read here as mirroring the Salaried row
 * directly above it (`>755` → 7.9) — the only other basis available, since the Self Employed row's
 * other two bands (`<695`, `695–755`) are identical to Salaried's, suggesting the whole table was
 * meant to be symmetric. Still a guess filling a real gap, not a transcribed number — confirm the
 * actual threshold with the source and correct if it turns out to differ.
 *
 * NO-FILE PRICING, confirmed by the product owner 2026-10-28: a no-bureau-file applicant gets the
 * same rate as the `<695` band (8.1%) for both employment types. Modeled as its own explicit `noFile:
 * true` row below (not inferred by letting the -1/0 sentinel arithmetically satisfy `cibil < 695` —
 * decisionEngine.ts deliberately never does that; see its rate-matching comment).
 *
 * Same pattern as ICICI HFC's own gap: common_parameter's CIBIL floor here is 700, so the rate
 * table's own `<695` band is unreachable in practice for a SCORED applicant (anyone scoring that low
 * is already rejected at the common_parameter gate) — it only ever fires via the explicit `noFile`
 * row above. Not flagged as broken, just noting the table has a band that can never trigger off a
 * real score.
 */
export const JIO_CREDIT_LIMITED_HL: LenderDecisionData = {
  displayName: 'Jio Credit Limited',
  repoLinked: true,
  creditBehaviorGroup: 'B',
  ageGreaterThan: { salaried: 23, self_employed: 25 },
  retirementAge: { salaried: 65, self_employed: 70 },
  minCibil: { salaried: 700, self_employed: 700 },
  noFileAccepted: { salaried: true, self_employed: true },
  requireNoFile: {},
  minIncome: { salaried: { cmp: 'gt', value: 75_000 }, self_employed: { cmp: 'gt', value: 100_000 } },
  loanAmount: {
    salaried: { min: 10_000_000, max: 300_000_000 },
    self_employed: { min: 10_000_000, max: 300_000_000 },
  },
  foirTiers: [
    { employment: 'salaried', foirCapPercent: 70 },
    { employment: 'self_employed', foirCapPercent: 80 },
  ],
  processingFee: [
    { employment: 'salaried', type: 'flat_rupees', value: 10_000 },
    { employment: 'self_employed', type: 'percent', value: 0.10 },
  ],
  rateTiers: [
    { employment: 'salaried', cibil: [{ cmp: 'lt', value: 695 }], ratePercent: 8.1 },
    { employment: 'salaried', cibil: [{ cmp: 'gte', value: 695 }, { cmp: 'lte', value: 755 }], ratePercent: 8.0 },
    { employment: 'salaried', cibil: [{ cmp: 'gt', value: 755 }], ratePercent: 7.9 },
    { employment: 'salaried', noFile: true, ratePercent: 8.1 },
    { employment: 'self_employed', cibil: [{ cmp: 'lt', value: 695 }], ratePercent: 8.1 },
    { employment: 'self_employed', cibil: [{ cmp: 'gte', value: 695 }, { cmp: 'lte', value: 755 }], ratePercent: 8.0 },
    { employment: 'self_employed', cibil: [{ cmp: 'gt', value: 755 }], ratePercent: 7.9 },
    { employment: 'self_employed', noFile: true, ratePercent: 8.1 },
  ],
};
