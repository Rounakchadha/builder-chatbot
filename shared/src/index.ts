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

// The flat list on the existing "what are you looking for" question (homeLoan.ts's 'product'
// step). Home loan/Loan against property continue into the existing, unchanged flow (including
// the Fresh purchase vs Balance transfer sub-choice that follows); the other three branch into
// their own short flows right after this question (see flows/personalLoan.ts etc.).
export const PRODUCT_OPTIONS = ['Home loan', 'Loan against property', 'Personal loan', 'Gold loan', 'Business loan'] as const;
export type ProductOption = (typeof PRODUCT_OPTIONS)[number];

// ---------- Personal loan ----------
export const QUALIFICATION_TYPES = ['Below 10th', '10th pass', '12th pass', 'Graduate', 'Post-graduate', 'Professional/Doctorate'] as const;

export const RESIDENCE_TYPES = ['Owned', 'Rented', 'Family owned'] as const;

// ---------- Gold loan ----------
export const GOLD_TYPES = ['Jewellery', 'Coin', 'Bars'] as const;

export const GOLD_PURITY_OPTIONS = ['18k', '20k', '22k', '24k', 'Not sure'] as const;

export const GOLD_LOAN_PURPOSES = ['Personal need', 'Medical', 'Education', 'Business', 'Agriculture', 'Wedding', 'Other'] as const;

// ---------- Business loan ----------
export const BUSINESS_LOAN_PURPOSES = ['Working capital', 'Machinery purchase', 'Expansion', 'Inventory purchase'] as const;

export const BUSINESS_TYPES = ['Proprietorship', 'Partnership', 'LLP', 'Private limited', 'Public limited', 'OPC'] as const;

export const INDUSTRY_TYPES = ['Manufacturing', 'Trading', 'Services'] as const;

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
  // Native date picker — e.g. Business loan's date of incorporation. `max` (YYYY-MM-DD) stops the
  // customer picking a future date; the widget also enforces it natively via the input's own max attr.
  z.object({ type: z.literal('date'), max: z.string().optional() }),
  // Type-to-search against a large server-side list (e.g. the employer master) — the widget calls
  // /api/chat/typeahead-search as the customer types and shows matches, plus an always-present
  // "Other" option for anything not found. See flows/personalLoan.ts's plEmployer step.
  z.object({ type: z.literal('typeahead'), placeholder: z.string().optional(), searchKey: z.string() }),
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
  // Optional because Gold loan doesn't ask for an employment segment at all (see flows/goldLoan.ts).
  segment?: Segment;
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
