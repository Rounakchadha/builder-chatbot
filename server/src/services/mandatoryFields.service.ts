import type { Answers } from '../flow-engine/types';
import { logger } from '../lib/logger';

/** Diagnostic-only check, run right before any product computes eligibility or creates a real
 * lead (2026-11-17 instruction: "we never go ahead with half info"). Originally blocked the
 * customer with a "please start over" message on a gap — changed the same day on direct
 * instruction: "dont start over just ask that field that is missing and then proceed". The real
 * fix for that is homeLoan.ts's `nameAsk`/`dobAsk` steps (the only two mandatory fields that never
 * had a question of their own anywhere in the flow); every other field here already has its own
 * dedicated ask-if-missing step upstream (the `pan`/`email`/`pincode`/`segment` questions). So
 * this is now just a cheap, synchronous (no API calls — "make it very fast") canary: if it ever
 * finds something missing, that means an upstream step's own guard has a genuine bug, worth
 * logging loudly, but nothing here blocks the customer on it anymore.
 *
 * Deliberately a flat list, not per-product — every product's flow asks for every one of these at
 * some point (see homeLoan.ts's dedupeCheck/profileFoundIdentityBackfill/nameAsk/dobAsk/panFetch
 * and the shared email/pincode/segment steps), so a gap here means an upstream step's own guard
 * genuinely missed something, not that this product never needed the field in the first place. */
const MANDATORY_IDENTITY_FIELDS = ['mobile', 'pan', 'name', 'dob', 'email', 'pincode', 'segment', 'creditScore'] as const;

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Empty array = everything's present. */
export function findMissingMandatoryFields(answers: Answers): string[] {
  return MANDATORY_IDENTITY_FIELDS.filter((field) => isMissing(answers[field]));
}

/** Logs once, loudly, with enough context to actually debug which step's guard let this through —
 * this should never fire if every upstream guard is doing its job, so a hit here is a real bug
 * report, not routine noise. Log-only — nothing blocks on this (see this file's own doc comment). */
export function logMissingMandatoryFields(conversationId: string, product: string, missing: string[]): void {
  logger.error({ event: 'mandatory_fields_missing', conversationId, product, missing }, 'a mandatory field is missing despite every upstream guard — eligibility/lead-creation proceeded anyway (log-only, not blocked)');
}
