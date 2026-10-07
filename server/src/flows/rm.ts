import { hashCode } from '../flow-engine/eligibility';

export const RMS = [
  { name: 'Ananya Rao', phone: '+91 98200 11223', email: 'ananya.rao@bankrm.example' },
  { name: 'Karan Mehta', phone: '+91 98330 55671', email: 'karan.mehta@bankrm.example' },
  { name: 'Priya Nair', phone: '+91 99870 40982', email: 'priya.nair@bankrm.example' },
  { name: 'Sameer Iyer', phone: '+91 90040 66210', email: 'sameer.iyer@bankrm.example' },
];

export function pickRm(seedKey: string) {
  return RMS[Math.abs(hashCode(seedKey)) % RMS.length];
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
