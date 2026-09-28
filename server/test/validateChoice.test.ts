import { describe, expect, it } from 'vitest';
import { matchChoiceDetailed } from '../src/lib/matchChoice';
import { validateChoice } from '../src/lib/validateChoice';
import type { StepContext } from '../src/flow-engine/types';

function ctx(): StepContext {
  return { answers: {}, conversationId: 'test', meta: { ip: '127.0.0.1' } };
}

describe('matchChoiceDetailed confidence tiers', () => {
  it('treats a full/confident phrase as a match', () => {
    expect(matchChoiceDetailed('self employed', ['Salaried', 'Business owner', 'Self-employed professional'])).toEqual({
      kind: 'match',
      option: 'Self-employed professional',
    });
  });

  it('treats a short ambiguous prefix as a suggestion, not an auto-match', () => {
    expect(matchChoiceDetailed('sal', ['Salaried', 'Business owner', 'Self-employed professional'])).toEqual({
      kind: 'suggestion',
      option: 'Salaried',
    });
  });

  it('uses semantic hints for intent that has no lexical overlap at all', () => {
    const hints = [{ pattern: /\bshop\b/i, option: 'Business owner' }];
    expect(matchChoiceDetailed('I own a shop', ['Salaried', 'Business owner'], hints)).toEqual({ kind: 'suggestion', option: 'Business owner' });
  });
});

describe('validateChoice confirm-before-guessing flow', () => {
  const options = ['Salaried', 'Business owner', 'Self-employed professional'];

  it('asks for confirmation on a low-confidence match instead of guessing or declining', () => {
    const c = ctx();
    const result = validateChoice(c, 'segment', options, 'sal', 'Are you salaried, a business owner, or self-employed?');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Salaried');
    expect(c.answers.__suggest_segment).toBe('Salaried');
  });

  it('confirms the pending suggestion on an affirmative follow-up', () => {
    const c = ctx();
    validateChoice(c, 'segment', options, 'sal', 'clarify?');
    const result = validateChoice(c, 'segment', options, 'yes', 'clarify?');
    expect(result).toEqual({ ok: true, parsed: 'Salaried' });
    expect(c.answers.__suggest_segment).toBeUndefined();
  });

  it('re-evaluates fresh when the follow-up is not a confirmation', () => {
    const c = ctx();
    validateChoice(c, 'segment', options, 'sal', 'clarify?');
    const result = validateChoice(c, 'segment', options, 'business owner', 'clarify?');
    expect(result).toEqual({ ok: true, parsed: 'Business owner' });
  });
});
