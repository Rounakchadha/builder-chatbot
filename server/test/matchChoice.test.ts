import { describe, expect, it } from 'vitest';
import { matchChoice } from '../src/lib/matchChoice';

describe('matchChoice', () => {
  it('matches exact option text case-insensitively', () => {
    expect(matchChoice('Salaried', ['Salaried', 'Business owner'])).toBe('Salaried');
    expect(matchChoice('business owner', ['Salaried', 'Business owner'])).toBe('Business owner');
  });

  it('matches natural phrasing via token overlap', () => {
    expect(matchChoice('self employed', ['Salaried', 'Business owner', 'Self-employed professional'])).toBe('Self-employed professional');
    expect(matchChoice('rent', ['Self-occupied', 'Rented', 'Vacant'])).toBe('Rented');
  });

  it('resolves yes/no phrasing against binary choices even when option text differs', () => {
    expect(matchChoice('yes', ['Yes, share PAN', 'Not right now'])).toBe('Yes, share PAN');
    expect(matchChoice('nope', ['Yes, share PAN', 'Not right now'])).toBe('Not right now');
    expect(matchChoice('not now', ['Yes', 'Not yet'])).toBe('Not yet');
  });

  it('expands common abbreviations before matching', () => {
    expect(matchChoice('lap', ['Home loan', 'Loan against property'])).toBe('Loan against property');
    expect(matchChoice('bt', ['Fresh purchase', 'Balance transfer (BT)'])).toBe('Balance transfer (BT)');
  });

  it('returns null for genuinely unrelated text', () => {
    expect(matchChoice('who is messi', ['Home loan', 'Loan against property'])).toBeNull();
  });
});
