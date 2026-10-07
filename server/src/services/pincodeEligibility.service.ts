import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Per-lender pincode serviceability — currently only used by Personal loan (see
 * flows/personalLoan.ts), not Home loan/LAP/Gold/Business loan. Each lender's own pincode list
 * is loaded once into a Set for O(1) lookups. Only PFL (Poonawala Fincorp) has a real list so far
 * (server/src/data/pflPincodes.json, ~10k eligible pincodes out of ~20.8k total, extracted from
 * "PFL Pincode_Syed_09012026.xlsx") — Tata and Unity are listed as lenders but have no pincode data
 * yet, so they're treated as serviceable everywhere until their own lists arrive (see the comment
 * on LENDER_PINCODES below). This only determines which lenders show up as eligible for a given
 * pincode — it says nothing about income/credit eligibility, which is handled separately.
 */
export const PERSONAL_LOAN_LENDERS = ['Poonawala Fincorp', 'Tata Capital', 'Unity Small Finance Bank'] as const;
export type PersonalLoanLender = (typeof PERSONAL_LOAN_LENDERS)[number];

const PFL_PINCODES: Set<string> = new Set(JSON.parse(readFileSync(join(__dirname, '../data/pflPincodes.json'), 'utf-8')));

/** One entry per lender in PERSONAL_LOAN_LENDERS. `null` means "no pincode list yet — treat as
 * serviceable everywhere" (Tata/Unity); swap in a real Set the same way PFL's was built once their
 * files are provided. */
const LENDER_PINCODES: Record<PersonalLoanLender, Set<string> | null> = {
  'Poonawala Fincorp': PFL_PINCODES,
  'Tata Capital': null,
  'Unity Small Finance Bank': null,
};

/** Which of the Personal loan lenders actually service this pincode. A lender with no pincode
 * list yet (null above) is always included — not yet knowing is not the same as being excluded. */
export function eligibleLendersForPincode(pincode: string): PersonalLoanLender[] {
  const p = pincode.trim();
  return PERSONAL_LOAN_LENDERS.filter((lender) => {
    const list = LENDER_PINCODES[lender];
    return list === null || list.has(p);
  });
}
