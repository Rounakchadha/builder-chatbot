import type { LenderOffer, Segment } from '@loan-chatbot/shared';

/**
 * Ported verbatim (formula-for-formula) from the prototype's
 * computeEligibility/computeLenderEligibility so behavior is provably
 * unchanged. This is the one area that must NEVER be touched by the LLM —
 * every number here is deterministic and unit-tested.
 */

export const LENDERS = [
  { name: 'HDFC Bank' },
  { name: 'ICICI Bank' },
  { name: 'SBI Home Loans' },
  { name: 'Axis Bank' },
  { name: 'Kotak Mahindra Bank' },
  { name: 'Bajaj Housing Finance' },
  { name: 'LIC Housing Finance' },
  { name: 'PNB Housing Finance' },
];

const FOIR_BY_SEGMENT: Record<string, number> = {
  Salaried: 0.55,
  'Business owner': 0.5,
  'Self-employed professional': 0.5,
};

export function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

export interface EligibilityInput {
  segment: Segment;
  product: string; // 'Home loan' | 'Loan against property'
  income: number;
  emi: number;
}

export interface EligibilityOutcome {
  eligible: boolean;
  emi: number;
  tenureYears: number;
  loanAmountLakh: string;
}

export function computeEligibility(a: EligibilityInput): EligibilityOutcome {
  const foir = FOIR_BY_SEGMENT[a.segment] ?? 0.5;
  const rateAnnual = a.product === 'Home loan' ? 0.09 : 0.105;
  const tenureYears = a.product === 'Home loan' ? 20 : 15;
  const n = tenureYears * 12;
  const r = rateAnnual / 12;

  const maxEmi = Math.max(0, a.income * foir - (a.emi || 0));
  const eligible = maxEmi > 1000; // needs at least a meaningful surplus EMI capacity

  const loanAmount = eligible ? (maxEmi * (Math.pow(1 + r, n) - 1)) / (r * Math.pow(1 + r, n)) : 0;
  const loanAmountLakh = (loanAmount / 100000).toFixed(1);

  return { eligible, emi: Math.round(maxEmi), tenureYears, loanAmountLakh };
}

export function computeLenderEligibility(a: EligibilityInput & { seedKey: string }, lender: { name: string }): LenderOffer {
  const seed = Math.abs(hashCode(lender.name + a.seedKey));
  let foir = (FOIR_BY_SEGMENT[a.segment] ?? 0.5) + (((seed % 7) - 3) / 100); // +/-3%
  foir = Math.min(0.65, Math.max(0.35, foir));

  const baseRate = a.product === 'Home loan' ? 0.09 : 0.105;
  const rate = Math.max(0.075, baseRate + ((((seed >> 3) % 9) - 4) / 1000)); // +/-40 bps

  const tenureYears = a.product === 'Home loan' ? 20 : 15;
  const n = tenureYears * 12;
  const r = rate / 12;

  const maxEmi = Math.max(0, a.income * foir - (a.emi || 0));
  const loanAmount = maxEmi > 1000 ? (maxEmi * (Math.pow(1 + r, n) - 1)) / (r * Math.pow(1 + r, n)) : 0;

  return {
    name: lender.name,
    amountLakh: Number((loanAmount / 100000).toFixed(1)),
    emi: Math.round(maxEmi),
    rate: (rate * 100).toFixed(2),
    tenureYears,
  };
}
