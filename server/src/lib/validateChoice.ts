import type { StepContext, ValidationResult } from '../flow-engine/types';
import { isAffirmative, matchChoiceDetailed, type SemanticHint } from './matchChoice';

/**
 * Validates a choice-type step's answer with a confirm-before-guessing step built in: a
 * low-confidence match ("sal", or a semantic hint like "I own a shop" -> Business owner) is
 * stashed on ctx.answers and surfaced as "Did you mean X?" rather than either silently accepted
 * or declined as unrelated. The next message, if affirmative, confirms it; anything else is
 * re-evaluated fresh (so the customer can just answer normally instead of being forced to say "no").
 */
export function validateChoice(
  ctx: StepContext,
  fieldKey: string,
  options: string[],
  value: string | undefined,
  clarifyingQuestion: string,
  semanticHints?: SemanticHint[],
): ValidationResult {
  const pendingKey = `__suggest_${fieldKey}`;
  const pending = ctx.answers[pendingKey] as string | undefined;

  if (pending) {
    delete ctx.answers[pendingKey];
    if (value && isAffirmative(value)) return { ok: true, parsed: pending };
  }

  const result = matchChoiceDetailed(value, options, semanticHints);
  if (result.kind === 'match') return { ok: true, parsed: result.option };
  if (result.kind === 'suggestion') {
    ctx.answers[pendingKey] = result.option;
    return { ok: false, error: `Did you mean "${result.option}"? Say yes if so, or tell me which one you meant.` };
  }
  return { ok: false, error: clarifyingQuestion };
}
