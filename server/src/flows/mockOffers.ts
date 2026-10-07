import type { LenderOffer } from '@loan-chatbot/shared';
import { hashCode } from '../flow-engine/eligibility';

/**
 * Placeholder lender-offer math for Personal/Gold/Business loan — mirrors the style of
 * flow-engine/eligibility.ts's home-loan mock (deterministic per seedKey, varied per lender) but
 * keyed off a requested amount rather than an income/FOIR formula, since that's what these three
 * products ask for directly. There's no real BRE integration for these products yet (see
 * lead.service.ts/eligibility.service.ts, which only know Home loan/LAP) — every number here is a
 * stand-in until Finfinity confirms real product codes/endpoints for Personal/Gold/Business loan.
 */
export function mockOffersForAmount(requestedLakh: number, lenders: string[], seedKey: string, baseRatePct: number, tenureYears: number): LenderOffer[] {
  return lenders
    .map((name) => {
      const seed = Math.abs(hashCode(name + seedKey));
      const factor = 0.7 + ((seed % 31) / 100); // 0.70x - 1.00x of what was requested
      const amountLakh = Number((requestedLakh * factor).toFixed(1));
      const rate = baseRatePct + (((seed >> 3) % 9) - 4) / 10; // +/- 0.4 percentage points
      const n = tenureYears * 12;
      const r = rate / 100 / 12;
      const principal = amountLakh * 100_000;
      const emi = principal > 0 ? Math.round((principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)) : 0;
      return { name, amountLakh, emi, rate: rate.toFixed(2), tenureYears };
    })
    .sort((a, b) => b.amountLakh - a.amountLakh);
}
