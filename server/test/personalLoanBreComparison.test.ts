import { describe, expect, it } from 'vitest';
import { lenderNamesMatch, reasonsOverlap } from '../src/flows/personalLoan';

describe('reasonsOverlap', () => {
  it('treats both-empty as agreement', () => {
    expect(reasonsOverlap([], [])).toBe(true);
  });

  it('treats one-empty-one-not as disagreement', () => {
    expect(reasonsOverlap([], ['Low CIBIL score'])).toBe(false);
  });

  it('matches on a shared keyword regardless of case/phrasing', () => {
    expect(reasonsOverlap(['Low CIBIL score'], ['Applicant CIBIL too low'])).toBe(true);
  });

  it('does not match on unrelated reasons', () => {
    expect(reasonsOverlap(['Age not in range'], ['Existing DPDs found'])).toBe(false);
  });
});

describe('lenderNamesMatch', () => {
  it('matches across each engine\'s own naming convention', () => {
    expect(lenderNamesMatch('Poonawala Fincorp', 'Poonawalla Fincorp Limited')).toBe(true);
    expect(lenderNamesMatch('Tata Capital', 'Tata Capital')).toBe(true);
  });

  it('does not match different lenders', () => {
    expect(lenderNamesMatch('Unity Small Finance Bank', 'Tata Capital')).toBe(false);
  });
});
