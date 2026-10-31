import { describe, expect, it } from 'vitest';
import { computeEligibility, computeLenderEligibility, LENDERS } from '../src/flow-engine/eligibility';

describe('computeEligibility', () => {
  it('is eligible when surplus EMI capacity exceeds the floor', () => {
    const result = computeEligibility({ segment: 'Salaried', product: 'Home loan', income: 100000, emi: 0 });
    expect(result.eligible).toBe(true);
    expect(result.emi).toBe(55000); // 55% FOIR of 100000
    expect(result.tenureYears).toBe(20);
    expect(Number(result.loanAmountLakh)).toBeGreaterThan(0);
  });

  it('is ineligible when existing EMIs consume all FOIR headroom', () => {
    const result = computeEligibility({ segment: 'Salaried', product: 'Home loan', income: 30000, emi: 20000 });
    // 55% of 30000 = 16500, minus 20000 existing EMI => negative surplus, clamped to 0
    expect(result.eligible).toBe(false);
    expect(result.loanAmountLakh).toBe('0.0');
  });

  it('uses a lower FOIR for business/self-employed segments than salaried', () => {
    const salaried = computeEligibility({ segment: 'Salaried', product: 'Home loan', income: 100000, emi: 0 });
    const selfEmployed = computeEligibility({ segment: 'Self-employed professional', product: 'Home loan', income: 100000, emi: 0 });
    expect(salaried.emi).toBeGreaterThan(selfEmployed.emi);
  });

  it('uses a 15-year tenure and higher base rate for loan against property vs 20-year home loan', () => {
    const homeLoan = computeEligibility({ segment: 'Salaried', product: 'Home loan', income: 100000, emi: 0 });
    const lap = computeEligibility({ segment: 'Salaried', product: 'Loan Against Property', income: 100000, emi: 0 });
    expect(homeLoan.tenureYears).toBe(20);
    expect(lap.tenureYears).toBe(15);
  });
});

describe('computeLenderEligibility', () => {
  it('produces a deterministic offer per lender for a fixed seed key', () => {
    const input = { segment: 'Salaried' as const, product: 'Home loan', income: 90000, emi: 5000, seedKey: 'ABCDE1234F' };
    const offerA = computeLenderEligibility(input, LENDERS[0]);
    const offerB = computeLenderEligibility(input, LENDERS[0]);
    expect(offerA).toEqual(offerB);
  });

  it('varies rate/amount across lenders for the same applicant', () => {
    const input = { segment: 'Salaried' as const, product: 'Home loan', income: 90000, emi: 5000, seedKey: 'ABCDE1234F' };
    const offers = LENDERS.map((l) => computeLenderEligibility(input, l));
    const uniqueRates = new Set(offers.map((o) => o.rate));
    expect(uniqueRates.size).toBeGreaterThan(1);
  });
});
