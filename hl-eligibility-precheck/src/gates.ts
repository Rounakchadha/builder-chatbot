/** Small reusable gate-accumulator shared by every lender module — identical contract to
 * pl-eligibility-precheck's GateChecker, copied rather than imported across the two services on
 * purpose (they must stay fully independent — see README.md). Keeps the "failed gate" vs. "skipped
 * gate (fact not supplied)" distinction consistent across every lender file. */
export class GateChecker {
  readonly reasons: string[] = [];
  readonly warnings: string[] = [];

  /** Fails the gate if `condition` is false. Use for anything built only from REQUIRED facts. */
  require(condition: boolean, reasonIfFailed: string): void {
    if (!condition) this.reasons.push(reasonIfFailed);
  }

  /** Fails the gate if `check(value)` is false — but only when `value` is actually known. When
   * it's `undefined`, the gate is recorded as skipped (a warning), never silently passed. */
  requireIfKnown<T>(value: T | undefined, reasonIfFailed: string, check: (v: T) => boolean): void {
    if (value === undefined) {
      this.warnings.push(`Not checked (fact not supplied): ${reasonIfFailed}`);
      return;
    }
    if (!check(value)) this.reasons.push(reasonIfFailed);
  }

  get eligible(): boolean {
    return this.reasons.length === 0;
  }
}

/** Every lender's advertised tenure is in whole years, so the max tenure reported back always
 * rounds DOWN to a multiple of 12 — never up, since that would overstate what's actually offered. */
export function roundDownToMultipleOf12(months: number): number {
  return Math.max(0, Math.floor(months / 12) * 12);
}

export function foir(facts: { monthlyIncome: number; existingMonthlyEmi?: number; proposedMonthlyEmi?: number }): number {
  const emi = (facts.existingMonthlyEmi ?? 0) + (facts.proposedMonthlyEmi ?? 0);
  if (facts.monthlyIncome <= 0) return Infinity;
  return emi / facts.monthlyIncome;
}

/** Loan-to-Value: the fraction of the property's value this loan would cover. */
export function ltv(facts: { loanAmountRequested: number; propertyValue: number }): number {
  if (facts.propertyValue <= 0) return Infinity;
  return facts.loanAmountRequested / facts.propertyValue;
}

/**
 * Flat LTV slabs, 2026-10-28 instruction — applied UNIFORMLY across every lender for now
 * ("lender wise rates later", not yet real per-lender data): loans up to ₹30L get a 90% LTV cap,
 * above ₹30L up to ₹75L get 80%, above ₹75L get 75% — the standard RBI housing-loan LTV slab
 * structure. Bracketed by the loan amount being sought (not the property value), matching how these
 * slabs are conventionally applied. Replace with real lender-specific LTV tables the moment they're
 * shared — don't keep this flat default once better data exists.
 */
export function getLtvCapPercent(loanAmountRequested: number): number {
  if (loanAmountRequested <= 3_000_000) return 0.90;
  if (loanAmountRequested <= 7_500_000) return 0.80;
  return 0.75;
}

const LOAN_AMOUNT_ROUNDING_STEP = 25_000;

/**
 * Turns a lender's own FOIR ceiling into an actual loan amount — same standard annuity math as
 * pl-eligibility-precheck's computeAffordableAmount.
 *
 * `ltvCapPercent` is OPTIONAL and defaults to no cap (Infinity): none of the real DMN files shared
 * so far (common_parameter, for_age, Income_Norms, for_repo_rate, lender_foir, lender_loan_amount,
 * lender_pf, lender_rate) include an actual Loan-to-Value ceiling table — so no lender in
 * lenders-data/ passes a real value here yet. `ltv()` above is kept ready for the day a real LTV
 * DMN is shared; until then, never pass a guessed ltvCapPercent — leave it unset.
 *
 * `maxEmi` is headroom DOWN TO the lender's own FOIR ceiling (foirCapPercent * income -
 * existingMonthlyEmi), not up to 100% of income — real policy, not advisory.
 */
export function computeAffordableAmount(
  foirCapPercent: number,
  facts: { monthlyIncome: number; existingMonthlyEmi?: number; tenureMonths: number; propertyValue: number },
  rateMinPercent: number,
  maxLoanAmountCeiling: number,
  minLoanAmount = 0,
  ltvCapPercent: number = Infinity,
): number {
  const maxEmi = Math.max(0, foirCapPercent * facts.monthlyIncome - (facts.existingMonthlyEmi ?? 0));
  const r = rateMinPercent / 100 / 12;
  const n = facts.tenureMonths;
  const incomeBasedAmount = r > 0 ? (maxEmi * (1 - Math.pow(1 + r, -n))) / r : maxEmi * n;
  const ltvBasedAmount = ltvCapPercent * facts.propertyValue;
  const amount = Math.min(incomeBasedAmount, ltvBasedAmount);
  const capped = Math.max(Math.min(amount, maxLoanAmountCeiling), minLoanAmount);
  // Rounded DOWN to a multiple of ₹25,000 — never up, since that would offer more than the math
  // actually supports.
  return Math.floor(capped / LOAN_AMOUNT_ROUNDING_STEP) * LOAN_AMOUNT_ROUNDING_STEP;
}
