import type { LenderOffer } from '@builder-chatbot/shared';

/**
 * Gold Loan's offer math (the only product still calling this — see flows/goldLoan.ts). The caller
 * already computes `requestedLakh` from a real formula (gold weight x purity rate x LTV cap), so
 * this just turns that capped amount into an EMI at a fixed rate.
 *
 * Used to also randomize the shown amount/rate per lender via a hash of (lender name + seedKey)
 * (security-review finding, 2026-10-23: "we have a real formula, why randomize the number on top of
 * it?") — removed, since two customers with the identical gold weight/purity have no reason to see
 * different amounts or rates. The result is still a placeholder (the per-gram rate isn't today's
 * live gold rate, and the interest rate is a fixed stand-in, not Muthoot's real pricing), so the
 * caller marks it `isEstimate` for the widget rather than presenting it as a locked offer.
 */
export function mockOffersForAmount(requestedLakh: number, lenders: string[], seedKey: string, baseRatePct: number, tenureYears: number): LenderOffer[] {
  void seedKey;
  return lenders
    .map((name) => {
      // 2 decimals (₹1,000 resolution), not 1 (₹10,000) — Gold loan amounts can legitimately be
      // small (a few grams of gold), and rounding to the coarser resolution was flooring genuine,
      // non-zero amounts down to exactly 0, which then read as "not eligible" even though a real
      // (if tiny) loan amount existed.
      const amountLakh = Number(requestedLakh.toFixed(2));
      const rate = baseRatePct;
      const n = tenureYears * 12;
      const r = rate / 100 / 12;
      const principal = amountLakh * 100_000;
      const emi = principal > 0 ? Math.round((principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)) : 0;
      return { name, amountLakh, emi, rate: rate.toFixed(2), tenureYears };
    })
    .sort((a, b) => b.amountLakh - a.amountLakh);
}
