const ZERO_WORDS = /^(no|none|nil|nothing|n\/?a|not any|zero|no emis?|no loans?|dont have any|don't have any)$/i;

/**
 * Understands the way people actually type a rupee amount in chat, not just a raw number typed
 * into a numeric field: "no"/"nil"/"none" -> 0, "85k" -> 85000, "1.2 lakh" -> 120000, "₹90,000" ->
 * 90000, "-5000" -> -5000 (negative is parsed, not silently dropped — callers that shouldn't accept
 * a negative amount already check for one, e.g. personalLoan.ts's plEmi step). Returns null when
 * nothing usable was said, so the caller can fall through to the guardrail (off-topic/domain
 * question) rather than a raw parse error.
 *
 * Security-review finding, 2026-10-23: this used to match a number+unit ANYWHERE in the string and
 * silently ignore everything else — "6 LPA" matched the bare "l" alternative as a lakh unit (reading
 * an annual-package figure as a monthly amount, 100,000x too literal) and "50000 for a car" silently
 * dropped " for a car" and returned 50000 with no sign that anything was ignored. Now requires the
 * ENTIRE (trimmed) input to be just a number and, optionally, one whole recognized unit word — any
 * leftover text (a stray unit fragment like "pa", unrelated commentary, a second number) means the
 * whole input is rejected as unparseable rather than silently guessed at. Trades a bit of
 * flexibility ("50000 for a car" now needs re-asking) for never silently misreading what was typed.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (ZERO_WORDS.test(text)) return 0;

  const cleaned = text.replace(/[₹,]/g, '');
  // Unit list also accepts "lk"/"lkh" (common chat shorthand for lakh — confirmed missing
  // 2026-10-30 after a user got stuck re-typing "70lk" forever, since it matched nothing and
  // silently returned null every time) and plain plurals ("lakhs"/"lacs"/"crores") — the entire-
  // string anchor above still rejects anything genuinely ambiguous, this only widens which single
  // whole word counts as the lakh/crore unit itself.
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(lakhs?|lacs?|lkh?|l|crores?|cr|k|thousand)?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (Number.isNaN(value)) return null;

  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'k' || unit === 'thousand' ? 1_000 : unit === 'crore' || unit === 'crores' || unit === 'cr' ? 10_000_000 : unit ? 100_000 : 1;

  return value * multiplier;
}
