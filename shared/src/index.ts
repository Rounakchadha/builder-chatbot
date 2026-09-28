import { z } from 'zod';

/**
 * Contract shared between the server (flow engine, source of truth) and the
 * widget (thin renderer). The widget never encodes business logic — every
 * step's copy, input type, and validation comes from this payload.
 */

export const STEP_TYPES = [
  'message', // bot-only message, auto-advances (e.g. after an apiFetch)
  'mobile',
  'otp',
  'pan',
  'choice', // a question with a fixed set of valid answers, rendered as buttons
  'number',
  'text', // free text, validated with plain rules server-side (no NLU)
  'apiFetch', // server performs an async lookup (dedupe, PAN, bureau) then auto-continues
  'result', // terminal step
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const ProductId = z.enum(['home_loan']); // future: personal_loan, credit_card, ...
export type ProductId = z.infer<typeof ProductId>;

// The two options on the very first 'intent' step — shared so the widget can re-submit one
// directly (e.g. the status-check result's "Check my eligibility" / "Check status again" buttons)
// without hardcoding a copy of the exact option string.
export const CHECK_ELIGIBILITY = 'Check my eligibility';
export const CHECK_EXISTING_APPLICATION = 'Check an existing application';

export const SEGMENTS = ['Salaried', 'Business owner', 'Self-employed professional'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const LOAN_TYPES: Record<string, string[]> = {
  'Home loan': ['Fresh purchase', 'Balance transfer (BT)'],
  'Loan against property': ['Property purchase', 'Loan against property (LAP)', 'Balance transfer (BT)'],
};

export const PROPERTY_TYPES: Record<string, string[]> = {
  'Home loan': ['Plot purchase', 'Row house', 'Bungalow', 'Apartment'],
  'Loan against property': ['Residential', 'Commercial', 'Industrial'],
};

// LAP-only — the collateral options depend on which of the three PROPERTY_TYPES['Loan against
// property'] values was picked. Not asked for Home loan at all.
export const COLLATERAL_TYPES: Record<string, string[]> = {
  Commercial: ['Plot', 'Godown', 'Hotel', 'School/College', 'Resort', 'Restaurant', 'Nursing Home', 'Hospital', 'APMC', 'Shop', 'Banquet Hall'],
  Industrial: ['Plot', 'Godown', 'Factory', 'Warehouse'],
  Residential: ['Plot', 'Apartment/Flat', 'Bunglow', 'Rowhouse'],
};

/** What the widget renders for the current step's input control. */
export const InputSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mobile') }),
  z.object({ type: z.literal('otp'), length: z.number().default(6) }),
  z.object({ type: z.literal('choice'), options: z.array(z.string()), layout: z.enum(['row', 'column']).default('column') }),
  z.object({ type: z.literal('number'), placeholder: z.string().optional(), min: z.number().optional() }),
  z.object({ type: z.literal('text'), placeholder: z.string().optional(), maxLength: z.number().optional() }),
  z.object({ type: z.literal('pan') }),
  z.object({ type: z.literal('none') }), // e.g. while an apiFetch is loading, or the terminal result step
]);
export type InputSpec = z.infer<typeof InputSpec>;

export const ChatTurnResponse = z.object({
  sessionToken: z.string(),
  stepId: z.string(),
  botMessage: z.string().nullable(),
  hint: z.string().nullable().optional(),
  input: InputSpec,
  progress: z.object({
    stepNumber: z.number(),
    totalSteps: z.number(),
    label: z.string(),
  }),
  loading: z.boolean().default(false), // widget shows a spinner row, then immediately calls /continue
  done: z.boolean().default(false),
  errorText: z.string().nullable().optional(),
  // Set only alongside errorText, for a none-type (apiFetch) step's error — 'restart' means
  // retrying the same step can only ever fail the same way again (a genuine dead end), so the
  // widget shows a button that actually leads somewhere instead of the default "Try again".
  errorAction: z.enum(['restart']).optional(),
  result: z.unknown().optional(), // EligibilityResultPayload when stepId === 'result'
  panOffer: z.boolean().optional(), // stepId === 'result' && no PAN on file — offer to share one for a lead
  panOfferNeedsMobile: z.boolean().optional(), // the panOffer must also collect a mobile number (no-contact-consent branch)
  statusCheck: z.boolean().optional(), // stepId === 'result' via the "check an existing application" intent
  // Present once identity (mobile + OTP) has just been verified — the widget stores this and
  // sends it back on a future brand-new session to skip asking for mobile+OTP again, as long as
  // it's still within the remembered window (see identity.service.ts).
  identityToken: z.string().optional(),
});
export type ChatTurnResponse = z.infer<typeof ChatTurnResponse>;

export const ChatMessageRequest = z.object({
  sessionToken: z.string().optional(),
  stepId: z.string().optional(), // omitted on the very first call
  value: z.string().optional(), // the answer, or free-typed text
  // Only read when starting a brand-new session (no sessionToken) — see identity.service.ts.
  // Lets a customer re-checking eligibility within the remembered window skip mobile+OTP entirely.
  identityToken: z.string().optional(),
});
export type ChatMessageRequest = z.infer<typeof ChatMessageRequest>;

export interface LenderOffer {
  name: string;
  amountLakh: number;
  emi: number;
  rate: string;
  tenureYears: number;
}

export interface EligibilityResultPayload {
  eligible: boolean;
  name?: string;
  product: string;
  loanType: string;
  segment: Segment;
  creditScore?: number;
  propertyType?: string;
  collateralType?: string;
  occupancy?: string;
  /** What the customer said the identified property is worth — only asked once a property is identified. */
  propertyValueLakh?: number;
  /** Pure income/FOIR-based eligibility, ignoring property value entirely — always computed. This
   * is the headline figure when no property is identified yet. */
  financialEligibilityLakh?: number;
  /** Only present once a property value is known: financialEligibilityLakh capped by an LTV % of
   * propertyValueLakh. Becomes the headline figure in that case, with financialEligibilityLakh
   * shown alongside it so the customer can see both numbers. */
  propertyCappedEligibilityLakh?: number;
  offers?: LenderOffer[];
  rm: { name: string; phone: string; email: string };
  leadId?: string;
  leadCreated: boolean;
}
