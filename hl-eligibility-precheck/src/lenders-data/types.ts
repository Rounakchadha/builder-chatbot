/**
 * Shared data shape every lender's real DMN decision tables (common_parameter, for_age,
 * Income_Norms, lender_foir, lender_loan_amount, lender_pf, lender_rate — from HL_BRE.zip,
 * 2026-10-28) get transcribed into, one file per lender under this folder. A generic evaluator
 * (../decisionEngine.ts) reads this shape instead of each lender hand-writing its own imperative
 * gate logic — unlike pl-eligibility-precheck's lenders, these 21 banks' real policies are pure,
 * dense decision tables (no DPD/tradeline/restructuring-style composite rules), so one generic
 * engine reading transcribed DATA is far less error-prone than 21 nearly-identical hand-written
 * files, while keeping the exact same "every number must trace to a real source row" discipline.
 */

export type Employment = 'salaried' | 'self_employed';

export type Cmp = 'gt' | 'gte' | 'lt' | 'lte';

export interface Cond {
  cmp: Cmp;
  value: number;
}

/** True only if EVERY condition in the list holds — an empty/absent list always holds (no bound). */
export function condsHold(x: number, conds: Cond[] | undefined): boolean {
  if (!conds || conds.length === 0) return true;
  return conds.every((c) => {
    switch (c.cmp) {
      case 'gt':
        return x > c.value;
      case 'gte':
        return x >= c.value;
      case 'lt':
        return x < c.value;
      case 'lte':
        return x <= c.value;
    }
  });
}

export interface RateTier {
  /** Omitted when the source row applies to both employment types identically (e.g. DBS, HSBC, IIFL). */
  employment?: Employment;
  income?: Cond[];
  /** True for the row that prices an applicant with NO bureau file at all (the source's literal
   * "0" / "-1" bureau_score rows — always priced identically to each other in every lender's data,
   * so merged into one row here instead of two near-duplicates). */
  noFile?: boolean;
  cibil?: Cond[];
  ratePercent: number;
}

export interface FoirTier {
  employment: Employment;
  income?: Cond[];
  foirCapPercent: number;
}

export interface ProcessingFeeTier {
  employment: Employment;
  income?: Cond[];
  type: 'flat_rupees' | 'percent';
  value: number;
}

export interface LenderDecisionData {
  /** Exact name string from the DMN source — used only in comments/docs, not matched against. */
  displayName: string;
  repoLinked: boolean;

  /** DMN's common_parameter age condition is always ">N" (strictly greater) — stored as the raw
   * threshold N, checked as `age > N`. Absent for an employment type the lender's DMN never covers
   * (e.g. State Bank of India has no Self Employed row anywhere) — the engine treats that as "no
   * published policy for this employment type", not a silent pass. */
  ageGreaterThan: Partial<Record<Employment, number>>;

  /** for_age sheet — age AT LOAN MATURITY (age + tenureMonths/12) must not exceed this. This sheet
   * gives both figures for every lender regardless of whether the lender otherwise covers that
   * employment type (e.g. SBI's non_salaried_retirement_age exists in for_age despite SBI having no
   * Self Employed policy anywhere else) — harmless to carry both, since the employment-coverage
   * check elsewhere already excludes unsupported employment types first. */
  retirementAge: Record<Employment, number>;

  /** The DMN's own CIBIL floor, normalized to an inclusive `score >= minCibil` threshold (a source
   * ">699" is stored here as 700 — mathematically identical for integer scores, just one fewer
   * comparison style to carry through the engine). */
  minCibil: Partial<Record<Employment, number>>;
  /** Whether a 0/-1 "no bureau file" score is ALSO accepted outongside the minCibil check — true for
   * every lender's common_parameter table except Aadhar Housing's Self Employed segment, which has
   * no such row at all (see aadharHousing.ts for the full anomaly writeup). Defaults assumed true
   * unless explicitly set false in a lender's data file. */
  noFileAccepted: Partial<Record<Employment, boolean>>;
  /** True only for Aadhar Housing's Salaried segment: the DMN defines ONLY a "<1" (no file) accepting
   * row for Salaried, with no ">=threshold" scored-file row at all — i.e. a salaried applicant WITH
   * a real bureau file has no defined acceptance path in this table. Faithfully modeled, not
   * softened. Defaults false for every other lender/segment. */
  requireNoFile: Partial<Record<Employment, boolean>>;

  /** Income_Norms sheet — almost always a strict `>` threshold in the source, but at least one row
   * (Bajaj Housing Finance, Self Employed) is genuinely `>=` — kept as a real Cond rather than
   * normalized, so each lender's actual comparator is preserved exactly as the DMN states it. */
  minIncome: Partial<Record<Employment, Cond>>;

  /** lender_loan_amount sheet — flat per employment type, no income tiering in the source. */
  loanAmount: Partial<Record<Employment, { min: number; max: number }>>;

  /** lender_foir sheet — ordered as in the source; first matching tier (by employment + income
   * bracket) wins, matching this project's established first-match-wins convention
   * (bre_pricing_rulesets' hit_policy, pl-eligibility-precheck's GateChecker ordering). */
  foirTiers: FoirTier[];

  /** lender_pf sheet. */
  processingFee: ProcessingFeeTier[];

  /** lender_rate sheet — by far the densest table; first matching tier (employment + income + cibil,
   * whichever are present on that row) wins. location_tier is never populated in the source (every
   * row is "-"), so it is not modeled here at all. */
  rateTiers: RateTier[];

  /** Which of the two shared credit-behavior (DPD/overdue/settlement/suit-filed/inquiries) rule
   * sets this lender uses — confirmed 2026-11-02, a separate table from everything above. Every
   * lender in this service falls into exactly one of the two groups; see decisionEngine.ts's
   * credit-behavior gates for the real per-group thresholds, and that table's own source image for
   * the 22nd lender (Kotak Bank, Group A) which still isn't buildable here for lack of its
   * age/CIBIL/income/FOIR/rate data. */
  creditBehaviorGroup: 'A' | 'B';
}
