import type { StepContext } from '../flow-engine/types';
import { maskMobile, maskPan } from '../lib/crypto';

/**
 * Fields the customer can revise after the fact — via the profile panel's edit pencil only (the
 * one and only real mechanism; POST /api/chat/edit is the sole caller of applyFieldEdit — there is
 * no free-text "change my income to 90000" chat parser anywhere in this codebase, despite an
 * earlier version of this comment implying one existed — confirmed and corrected 2026-10-17).
 * Deliberately limited to "leaf" fields with no downstream dependents: editing income/EMI/segment/
 * pincode/score only ever changes numbers, never which questions were asked. product/loanType/
 * propertyType/occupancy are excluded because changing them could invalidate answers already given
 * for later, dependent questions — safer to have the customer restart in that case than to
 * silently leave the flow in an inconsistent state.
 */
export interface EditableField {
  key: 'segment' | 'income' | 'emi' | 'pincode' | 'email' | 'blBusinessAddress';
  label: string;
  format: (ctx: StepContext) => string;
  /** An existing (dedupe-found) customer's segment/pincode/email came from Finfinity's own
   * records, verified via the real dedupe/PAN lookup — letting the chatbot freely overwrite them
   * would edit data we don't actually own. income/emi are always self-declared by the customer
   * either way, so those stay editable regardless of found/not-found. */
  editableFor: (ctx: StepContext) => boolean;
}

const FOUND_CUSTOMER_EDITABLE_KEYS = new Set(['income', 'emi']);

function editableForFoundOrNot(key: EditableField['key']) {
  return (ctx: StepContext) => ctx.answers.dedupeFound !== true || FOUND_CUSTOMER_EDITABLE_KEYS.has(key);
}

export const EDITABLE_FIELDS: EditableField[] = [
  { key: 'segment', label: 'Employment type', format: (ctx) => (ctx.answers.segment as string) ?? '', editableFor: editableForFoundOrNot('segment') },
  {
    key: 'income',
    label: 'Monthly income',
    format: (ctx) => (ctx.answers.income ? `₹${Number(ctx.answers.income).toLocaleString('en-IN')}` : ''),
    editableFor: editableForFoundOrNot('income'),
  },
  {
    key: 'emi',
    label: 'Existing EMIs',
    format: (ctx) => (ctx.answers.emi !== undefined ? (ctx.answers.emi ? `₹${Number(ctx.answers.emi).toLocaleString('en-IN')}/mo` : 'None') : ''),
    editableFor: editableForFoundOrNot('emi'),
  },
  {
    key: 'pincode',
    label: 'Pincode',
    format: (ctx) => (ctx.answers.pincode ? `${ctx.answers.pincode}${ctx.answers.pincodeArea ? ` (${ctx.answers.pincodeArea})` : ''}` : ''),
    editableFor: editableForFoundOrNot('pincode'),
  },
  { key: 'email', label: 'Email', format: (ctx) => (ctx.answers.email as string) ?? '', editableFor: editableForFoundOrNot('email') },
  // Business Loan: only the registered address is editable (2026-10-17 instruction — "only
  // address will be editable nothing else not gst not address nothing else"). Business name,
  // entity type, and GST number are shown read-only in PROFILE_FIELDS below instead.
  {
    key: 'blBusinessAddress',
    label: 'Registered address',
    format: (ctx) => (ctx.answers.blBusinessAddress as string) ?? '',
    editableFor: () => true,
  },
];

export function isEditableField(key: string): key is EditableField['key'] {
  return EDITABLE_FIELDS.some((f) => f.key === key);
}

/** The single source of truth for whether THIS conversation may edit THIS field right now — used
 * both to decide which pencils the profile panel shows and to actually authorize a save, so the
 * two can never disagree. */
export function isFieldEditableNow(ctx: StepContext, key: string): boolean {
  const field = EDITABLE_FIELDS.find((f) => f.key === key);
  return field ? field.editableFor(ctx) : false;
}

/**
 * Everything the profile panel displays — a superset of EDITABLE_FIELDS. The read-only ones
 * (identity, product/property choices) mirror the same recap shown in the chat's profile-summary
 * message, just kept live in the sidebar; only the `editable` ones get an edit pencil in the UI.
 */
export interface ProfileField {
  key: string;
  label: string;
  editable: (ctx: StepContext) => boolean;
  format: (ctx: StepContext) => string;
}

export const PROFILE_FIELDS: ProfileField[] = [
  { key: 'name', label: 'Name', editable: () => false, format: (ctx) => (ctx.answers.name as string) ?? '' },
  { key: 'mobile', label: 'Mobile', editable: () => false, format: (ctx) => (ctx.answers.mobile ? `+91 ${maskMobile(ctx.answers.mobile as string)}` : '') },
  { key: 'pan', label: 'PAN', editable: () => false, format: (ctx) => (ctx.answers.pan ? maskPan(ctx.answers.pan as string) : '') },
  { key: 'creditScore', label: 'CIBIL score', editable: () => false, format: (ctx) => (ctx.answers.creditScore ? String(ctx.answers.creditScore) : '') },
  ...EDITABLE_FIELDS.map((f) => ({ key: f.key, label: f.label, editable: f.editableFor, format: f.format })),
  { key: 'blBusinessName', label: 'Business name', editable: () => false, format: (ctx) => (ctx.answers.blBusinessName as string) ?? '' },
  { key: 'blBusinessType', label: 'Entity type', editable: () => false, format: (ctx) => (ctx.answers.blBusinessType as string) ?? '' },
  { key: 'blGstNumber', label: 'GST number', editable: () => false, format: (ctx) => (ctx.answers.blGstNumber as string) ?? '' },
  { key: 'blOfficeAddress', label: 'Office address', editable: () => false, format: (ctx) => (ctx.answers.blOfficeAddress as string) ?? '' },
  {
    key: 'product',
    label: 'Product',
    editable: () => false,
    format: (ctx) => (ctx.answers.product ? `${ctx.answers.product}${ctx.answers.loanType ? ` — ${ctx.answers.loanType}` : ''}` : ''),
  },
  { key: 'propertyType', label: 'Property type', editable: () => false, format: (ctx) => (ctx.answers.propertyType as string) ?? '' },
  { key: 'collateralType', label: 'Collateral type', editable: () => false, format: (ctx) => (ctx.answers.collateralType as string) ?? '' },
  { key: 'occupancy', label: 'Occupancy', editable: () => false, format: (ctx) => (ctx.answers.occupancy as string) ?? '' },
];
