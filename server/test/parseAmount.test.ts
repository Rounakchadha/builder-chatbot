import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/lib/parseAmount';

describe('parseAmount', () => {
  it('parses plain numbers', () => {
    expect(parseAmount('85000')).toBe(85000);
    expect(parseAmount('12000')).toBe(12000);
  });

  it('understands zero-words instead of forcing a literal 0', () => {
    for (const word of ['no', 'No', 'none', 'nil', 'nothing', 'n/a', 'zero', "don't have any"]) {
      expect(parseAmount(word)).toBe(0);
    }
  });

  it('understands k/lakh/crore suffixes', () => {
    expect(parseAmount('85k')).toBe(85000);
    expect(parseAmount('1.2 lakh')).toBe(120000);
    expect(parseAmount('2 crore')).toBe(20000000);
  });

  it('strips currency symbols and commas', () => {
    expect(parseAmount('₹90,000')).toBe(90000);
  });

  it('returns null for unparseable text', () => {
    expect(parseAmount('asdf')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});
