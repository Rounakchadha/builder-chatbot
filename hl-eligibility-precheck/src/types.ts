/**
 * 'business_owner' is accepted at the request level for consistency with the PL service, but every
 * real Home Loan DMN table shared so far only ever distinguishes "Salaried" vs. "Self Employed" —
 * there is no third bucket anywhere in the source data. The engine maps 'business_owner' onto
 * 'self_employed' (see decisionEngine.ts) rather than inventing a third real policy bucket that
 * doesn't exist in any DMN.
 */
export type EmploymentType = 'salaried' | 'self_employed' | 'business_owner';

export type PropertyType = 'ready_to_move' | 'under_construction' | 'resale' | 'plot_and_construction';

/**
 * Everything a Home Loan lender's gate might need. Mirrors pl-eligibility-precheck's
 * ApplicantFacts shape and the same required-vs-optional discipline: only the fields below marked
 * required are guaranteed present; every lender-specific gate beyond these reads an optional field
 * and must be added here (with a comment naming which lender/DMN needs it) before any lender file
 * uses it. A gate built on a field the caller didn't supply is SKIPPED, not assumed to pass — see
 * LenderEligibilityResult.warnings.
 *
 * Deliberately NOT a copy-paste merge with pl-eligibility-precheck's ApplicantFacts — Home Loan has
 * its own facts (property value, LTV, construction status) that Personal Loan has no use for, and
 * vice versa (no property fields belong in a PL applicant). Two separate types, two separate files,
 * same shape of discipline.
 */
export interface ApplicantFacts {
  cibilScore: number;
  monthlyIncome: number;
  employmentType: EmploymentType;
  age: number;
  pincode: string;
  /** Total property value as per the sale agreement / lender's own valuation, whichever this fact
   * represents — every lender's Loan-to-Value gate is computed against it. */
  propertyValue: number;
  loanAmountRequested: number;
  tenureMonths: number;
  propertyType: PropertyType;
  /** Existing monthly EMI obligations (other loans) — defaults to 0 if omitted. */
  existingMonthlyEmi?: number;
  /** This lender's own EMI for the requested loan/tenure/rate — defaults to 0 if omitted, which
   * will understate FOIR. Callers should pass the real computed EMI for an accurate FOIR check. */
  proposedMonthlyEmi?: number;

  // Credit-behavior facts below (confirmed 2026-11-02) — shared by two lender groups, applied via
  // decisionEngine.ts's credit-behavior gates (see each lender's own `creditBehaviorGroup` in
  // lenders-data/types.ts). All optional, same "skipped, not assumed to pass" discipline as every
  // other optional fact — a gate built on one the caller didn't supply shows up as a warning, not a
  // silent pass. Group A and Group B measure some of these over different lookback windows with
  // different carve-outs, so each gets its own field rather than forcing one shared field to cover
  // two different real definitions.

  /** Group A's own reading: ANY overdue amount on ANY currently active loan disqualifies, no
   * carve-outs at all. */
  hasOverdueOnActiveLoan?: boolean;
  /** Group B's own reading: same, but loans in Agri/KCC (Kisan Credit Card)/GL (Gold Loan) are
   * excluded from this check entirely. */
  hasOverdueOnActiveLoanExclAgriKccGl?: boolean;
  /** Both groups: ever been 90+ days past due in the last 24 months. */
  dpd90PlusLast24Months?: boolean;
  /** Group A: ever been 30+ DPD in the last 12 months, excluding credit cards and any outstanding
   * under ₹10,000. */
  dpd30PlusLast12MonthsExclCcAndSmallOs?: boolean;
  /** Group B: same idea, but the window is only the last 6 months, and Agri/KCC/GL loans are ALSO
   * excluded (in addition to credit cards and sub-₹10,000 outstanding). */
  dpd30PlusLast6MonthsExclAgriKccGlCcAndSmallOs?: boolean;
  /** Group A's first 0+ DPD sub-condition: any days-past-due at all within the last 15 days. */
  dpdAnyInLast15Days?: boolean;
  /** Group A's second 0+ DPD sub-condition (ANDed with the one above): count of 0+ DPD occurrences
   * in the last 6 months — disqualifying once it exceeds 3. */
  dpdOccurrencesLast6Months?: number;
  /** Group B's own single 0+ DPD condition: count of occurrences in the last 3 months —
   * disqualifying once it exceeds 3. */
  dpdOccurrencesLast3Months?: number;
  /** Group A: true if a settlement/write-off was reported in the last 24 months for an amount over
   * ₹10,000 — EXCLUDING one on a Home Loan/LAP/Auto Loan/Personal Loan settled more than 10 years
   * ago, or a Credit Card settled more than 3 years ago (those carve-outs must already be applied
   * by whoever computes this fact; this service does not re-derive it from raw tradeline dates). */
  hasDisqualifyingSettlementOrWriteOffGroupA?: boolean;
  /** Group B: same idea, but the window is the last 12 months and the amount threshold is
   * ₹25,000 — same HL/LAP/AL/PL >10yr and Card >3yr carve-outs apply. */
  hasDisqualifyingSettlementOrWriteOffGroupB?: boolean;
  /** Both groups: a suit-filed or willful-defaulter status currently being reported. */
  hasSuitFiledOrWillfulDefaulter?: boolean;
  /** Both groups: count of bureau inquiries in the last 6 months, specifically for Home Loan —
   * Group A disqualifies above 5, Group B above 10 (see decisionEngine.ts). */
  inquiriesLast6MonthsForHl?: number;
}

/**
 * 2026-10-28: real DMN data shared (HL_BRE.zip — common_parameter, for_age, Income_Norms,
 * for_repo_rate, lender_foir, lender_loan_amount, lender_pf, lender_rate), 21 lenders with full
 * coverage across all tables.
 *
 * Deliberately suffixed/renamed vs. pl-eligibility-precheck's codes for the same bank name (e.g.
 * `AXIS_BANK_HL` here vs. `AXIS_BANK` there, `HDFC_BANK_HL` vs. `HDFC`) — a bank's Home Loan and
 * Personal Loan products are different products with different real policies, and the two services
 * must never be confused with each other even by code string collision.
 *
 * NOT onboarded despite appearing in the source data: `Kotak Bank` — it exists ONLY in the
 * for_repo_rate sheet (as "Repo Linked") and nowhere in common_parameter/age/income/FOIR/loan
 * amount/PF/rate. There is no real data to build a gate or a rate from, so it is excluded rather
 * than guessed — same discipline as pl-eligibility-precheck excluding Finnable/Cholamandalam/
 * Piramal Finance when their data didn't hold up.
 */
export type LenderCode =
  | 'ADITYA_BIRLA_HOUSING'
  | 'AXIS_BANK_HL'
  | 'BAJAJ_HOUSING_FINANCE'
  | 'FEDERAL_BANK_HL'
  | 'HDFC_BANK_HL'
  | 'ICICI_BANK_HL'
  | 'ICICI_HFC'
  | 'IDFC_FIRST_BANK_HL'
  | 'IIFL_HL'
  | 'LT_HOUSING_FINANCE'
  | 'PIRAMAL_HOUSING'
  | 'PNB_HOUSING'
  | 'RBL_BANK_HL'
  | 'TATA_CAPITAL_HOUSING'
  | 'DBS_HL'
  | 'KARUR_VYSYA_HL'
  | 'HSBC_HL'
  | 'JIO_CREDIT_LIMITED_HL'
  | 'SBI_HL'
  | 'BANK_OF_BARODA_HL'
  | 'AADHAR_HOUSING';

export interface LenderEligibilityResult {
  lender: LenderCode;
  eligible: boolean;
  /** Every gate that actually failed, in plain language. Empty when eligible. */
  reasons: string[];
  /** Gates skipped because the optional fact needed to check them wasn't supplied — these are NOT
   * failures, but "eligible: true" alongside a non-empty warnings list means some real policy gates
   * were never actually checked. */
  warnings: string[];
  /** Only present when eligible — this lender's own lowest advertised rate. Never set from memory
   * or estimation; only from a real published figure or an explicitly disclosed placeholder (see
   * pricing.ts's rateIsPlaceholder convention, carried over from pl-eligibility-precheck). */
  estimatedRatePercent?: number;
  /** Only present when eligible — computed off this lender's own FOIR ceiling AND its own max
   * Loan-to-Value ceiling against propertyValue, whichever binds tighter. See gates.ts. */
  maxEligibleAmount?: number;
  /** "X%" from the source lender_pf sheet. Only one of this and processingFeeFlatRupees is ever set
   * for a given lender — many Home Loan lenders quote a flat rupee processing fee instead of a
   * percentage (e.g. "₹10,000"), unlike every lender in pl-eligibility-precheck, which only ever
   * quoted percentages. */
  processingFeePercentMin?: number;
  /** A flat rupee processing fee from the source lender_pf sheet (e.g. ₹10,000) — see
   * processingFeePercentMin's comment. */
  processingFeeFlatRupees?: number;
  maxTenureMonths?: number;
  lockInPeriodMonths?: number;
}

export interface EligibilityCheckRequest {
  facts: ApplicantFacts;
  /** Defaults to all onboarded lenders if omitted. */
  lenders?: LenderCode[];
}

export interface EligibilityCheckResponse {
  results: LenderEligibilityResult[];
}
