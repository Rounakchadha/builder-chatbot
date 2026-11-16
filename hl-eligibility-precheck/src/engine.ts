import { evaluateLender } from './decisionEngine.js';
import { ADITYA_BIRLA_HOUSING } from './lenders-data/adityaBirlaHousing.js';
import { AXIS_BANK_HL } from './lenders-data/axisBankHl.js';
import { BAJAJ_HOUSING_FINANCE } from './lenders-data/bajajHousingFinance.js';
import { FEDERAL_BANK_HL } from './lenders-data/federalBankHl.js';
import { HDFC_BANK_HL } from './lenders-data/hdfcBankHl.js';
import { ICICI_BANK_HL } from './lenders-data/iciciBankHl.js';
import { ICICI_HFC } from './lenders-data/iciciHfc.js';
import { IDFC_FIRST_BANK_HL } from './lenders-data/idfcFirstBankHl.js';
import { IIFL_HL } from './lenders-data/iiflHl.js';
import { LT_HOUSING_FINANCE } from './lenders-data/ltHousingFinance.js';
import { PIRAMAL_HOUSING } from './lenders-data/piramalHousing.js';
import { PNB_HOUSING } from './lenders-data/pnbHousing.js';
import { RBL_BANK_HL } from './lenders-data/rblBankHl.js';
import { TATA_CAPITAL_HOUSING } from './lenders-data/tataCapitalHousing.js';
import { DBS_HL } from './lenders-data/dbsHl.js';
import { KARUR_VYSYA_HL } from './lenders-data/karurVysyaHl.js';
import { HSBC_HL } from './lenders-data/hsbcHl.js';
import { JIO_CREDIT_LIMITED_HL } from './lenders-data/jioCreditLimitedHl.js';
import { SBI_HL } from './lenders-data/sbiHl.js';
import { BANK_OF_BARODA_HL } from './lenders-data/bankOfBarodaHl.js';
import { AADHAR_HOUSING } from './lenders-data/aadharHousing.js';
import type { LenderDecisionData } from './lenders-data/types.js';
import type { ApplicantFacts, EligibilityCheckResponse, LenderCode } from './types.js';

// 2026-10-28: full build from HL_BRE.zip's real DMN data — 21 lenders. Kotak Bank excluded (see
// types.ts's LenderCode comment: it exists only in the repo-rate sheet, nowhere else).
const LENDER_DATA: Record<LenderCode, LenderDecisionData> = {
  ADITYA_BIRLA_HOUSING,
  AXIS_BANK_HL,
  BAJAJ_HOUSING_FINANCE,
  FEDERAL_BANK_HL,
  HDFC_BANK_HL,
  ICICI_BANK_HL,
  ICICI_HFC,
  IDFC_FIRST_BANK_HL,
  IIFL_HL,
  LT_HOUSING_FINANCE,
  PIRAMAL_HOUSING,
  PNB_HOUSING,
  RBL_BANK_HL,
  TATA_CAPITAL_HOUSING,
  DBS_HL,
  KARUR_VYSYA_HL,
  HSBC_HL,
  JIO_CREDIT_LIMITED_HL,
  SBI_HL,
  BANK_OF_BARODA_HL,
  AADHAR_HOUSING,
};

const ALL_LENDERS: LenderCode[] = Object.keys(LENDER_DATA) as LenderCode[];

export function evaluateEligibility(facts: ApplicantFacts, lenders: LenderCode[] = ALL_LENDERS): EligibilityCheckResponse {
  return { results: lenders.map((code) => evaluateLender(code, LENDER_DATA[code], facts)) };
}
