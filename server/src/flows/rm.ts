// Was a pool of 4 entirely made-up RMs (fake phone numbers, @bankrm.example emails), picked by
// hashing some seed so the same customer always saw the same fake name — a real customer could
// actually try calling one of these numbers and reach nobody (security/trust-review finding,
// 2026-10-23). The real create_anacity_lead API call has, in every test this session, returned the
// SAME real UAT relationship manager (Anirudh Gupta) whenever it returns one at all — using that as
// the fallback instead means a customer only ever sees a genuine Finfinity employee, never a
// fabricated identity, on the rare occasions the real API's own RM field comes back empty. Revisit
// once in production — this is UAT's one actual default RM, not "the" RM for every real customer.
const DEFAULT_RM = { name: 'Anirudh Gupta', phone: '+91 72066 72332', email: 'anirudh@finfinity.co.in' };

export function pickRm(_seedKey: string) {
  return DEFAULT_RM;
}

export function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

export function generateLeadId(): string {
  return 'LN' + Date.now().toString().slice(-6) + Math.random().toString(36).slice(2, 4).toUpperCase();
}

/** The closing line for Personal/Gold/Business loan's result step — states the lead id and RM by
 * name so the customer knows what happens next, not just a result card with no explicit next step. */
export function leadCreatedMessage(leadId: string | undefined, rm: { name: string }): string {
  return leadId
    ? `Your lead (${leadId}) has been created — ${rm.name} will be your dedicated relationship manager and will reach out to you shortly.`
    : `${rm.name} will be your dedicated relationship manager and will reach out to you shortly.`;
}
