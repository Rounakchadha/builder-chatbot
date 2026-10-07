import type { ValidationResult } from '../flow-engine/types';

// "none"/"na"/"n/a" etc. are refused outright — a landmark is required, same spirit as MIN_SANE_INCOME
// elsewhere: reject obvious non-answers rather than silently accepting a placeholder.
const NON_ANSWER_PATTERN = /^(none|no|na|n\/a|nothing|not applicable|nil|skip|-)$/i;

/** Shared by Personal/Business loan's residence/business address questions (see personalLoan.ts,
 * businessLoan.ts) — rejects a bare number (someone typing just a pincode or house number) and
 * requires enough letters to look like an actual address, not a validated/geocoded one (no address
 *-verification API exists), just enough to catch obviously-wrong input. */
export function validateAddress(value: string | undefined): ValidationResult {
  const v = (value || '').trim();
  if (v.length < 8) return { ok: false, error: 'Enter your full address — not just a number or a short word.' };
  if (/^\d+$/.test(v)) return { ok: false, error: "That looks like just a number — enter your full address (house/flat, street, area)." };
  if (!/[a-zA-Z]{3,}/.test(v)) return { ok: false, error: 'Enter your full address — not just a number or a short word.' };
  return { ok: true, parsed: v };
}

/** A real landmark is required — "none"/blank is refused rather than defaulted, since the customer
 * explicitly said not to accept "no" for an answer here. */
export function validateLandmark(value: string | undefined): ValidationResult {
  const v = (value || '').trim();
  if (v.length < 3 || NON_ANSWER_PATTERN.test(v)) return { ok: false, error: 'Enter a nearby landmark — this helps locate the address.' };
  return { ok: true, parsed: v };
}

export function validatePincode(value: string | undefined): ValidationResult {
  const v = (value || '').trim();
  if (!/^[1-9]\d{5}$/.test(v)) return { ok: false, error: 'Enter a valid 6-digit pincode.' };
  return { ok: true, parsed: v };
}
