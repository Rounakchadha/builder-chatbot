const SYNONYMS: [RegExp, string][] = [
  [/\blap\b/gi, 'loan against property'],
  [/\bbt\b/gi, 'balance transfer'],
];

const AFFIRMATIVE = /^(yes|yeah|yep|yup|sure|ok(ay)?|of course|correct|i (will|do|can)|share( it)?)$/i;
const NEGATIVE = /^(no|nope|nah|not (now|yet|really|interested)|skip|later|don'?t want to)$/i;

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(text.trim().toLowerCase());
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export type ChoiceMatch = { kind: 'match'; option: string } | { kind: 'suggestion'; option: string } | { kind: 'none' };

export interface SemanticHint {
  pattern: RegExp;
  option: string;
}

/**
 * Matches free-typed text against a fixed list of valid options, with a confidence tier:
 * - "match": confident enough to accept outright ("self employed", "rent", a full sentence
 *   containing the option's exact words).
 * - "suggestion": plausible but too thin to accept blindly (a short prefix like "sal", or a
 *   semantic hint like "I own a shop" implying "Business owner") — the caller should ask
 *   "did you mean X?" rather than silently guessing OR declining as unrelated.
 * - "none": nothing recognizable.
 */
export function matchChoiceDetailed(raw: string | undefined, options: string[], semanticHints?: SemanticHint[]): ChoiceMatch {
  if (!raw) return { kind: 'none' };
  let v = raw.trim().toLowerCase();
  if (!v) return { kind: 'none' };
  for (const [pattern, replacement] of SYNONYMS) v = v.replace(pattern, replacement);

  const exact = options.find((o) => o.toLowerCase() === v);
  if (exact) return { kind: 'match', option: exact };

  // Binary yes/no-shaped choices (PAN consent, "have you identified the property") — the option
  // text itself rarely matches how someone actually says yes/no.
  if (options.length === 2) {
    const yesOpt = options.find((o) => /^yes\b/i.test(o));
    const noOpt = options.find((o) => o !== yesOpt);
    if (yesOpt && noOpt) {
      if (AFFIRMATIVE.test(v)) return { kind: 'match', option: yesOpt };
      if (NEGATIVE.test(v)) return { kind: 'match', option: noOpt };
    }
  }

  const contains = options.filter((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
  if (contains.length === 1) {
    // A short fragment that merely prefixes a long option name ("sal" -> "Salaried") is
    // low-confidence — could be a typo or the start of an unrelated word.
    const isShortPrefix = v.length <= 3 && contains[0].toLowerCase().startsWith(v);
    return isShortPrefix ? { kind: 'suggestion', option: contains[0] } : { kind: 'match', option: contains[0] };
  }

  const vTokens = new Set(tokenize(v));
  let best: { option: string; score: number } | null = null;
  for (const o of options) {
    const score = tokenize(o).filter((t) => vTokens.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { option: o, score };
  }
  if (best) return { kind: best.score >= 2 ? 'match' : 'suggestion', option: best.option };

  if (semanticHints) {
    for (const hint of semanticHints) {
      if (hint.pattern.test(v)) return { kind: 'suggestion', option: hint.option };
    }
  }

  return { kind: 'none' };
}

/** Simple string|null form for callers that don't need the confidence tier (treats "suggestion" as a match). */
export function matchChoice(raw: string | undefined, options: string[]): string | null {
  const result = matchChoiceDetailed(raw, options);
  return result.kind === 'none' ? null : result.option;
}
