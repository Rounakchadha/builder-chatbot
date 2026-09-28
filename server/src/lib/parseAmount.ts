const ZERO_WORDS = /^(no|none|nil|nothing|n\/?a|not any|zero|no emis?|no loans?|dont have any|don't have any)$/i;

/**
 * Understands the way people actually type a rupee amount in chat, not just a raw number typed
 * into a numeric field: "no"/"nil"/"none" -> 0, "85k" -> 85000, "1.2 lakh" -> 120000, "₹90,000" ->
 * 90000, "about 12000 a month" -> 12000. Returns null when nothing usable was said, so the caller
 * can fall through to the guardrail (off-topic/domain-question) rather than a raw parse error.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (ZERO_WORDS.test(text)) return 0;

  const cleaned = text.replace(/[₹,]/g, '');
  const match = cleaned.match(/(\d+(\.\d+)?)\s*(lakh|lac|l|crore|cr|k|thousand)?/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (Number.isNaN(value)) return null;

  const unit = match[3]?.toLowerCase();
  const multiplier = unit === 'k' || unit === 'thousand' ? 1_000 : unit === 'lakh' || unit === 'lac' || unit === 'l' ? 100_000 : unit === 'crore' || unit === 'cr' ? 10_000_000 : 1;

  return value * multiplier;
}
