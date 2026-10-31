import { BUSINESS_LOAN_PURPOSES, BUSINESS_TYPES, INDUSTRY_TYPES, type EligibilityResultPayload } from '@builder-chatbot/shared';
import type { StepContext, StepDefinition } from '../flow-engine/types';
import { escapeHtml } from '../lib/escapeHtml';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { validateAddress, validateLandmark, validatePincode } from './addressValidation';
import { pincodeService } from '../services/pincode.service';
import { leadCreatedMessage } from './rm';
import {
  businessLoanService,
  CONSTITUTION_TO_BUSINESS_TYPE,
  panEntityCategory,
  BUSINESS_TYPE_OPTIONS_BY_CATEGORY,
  disambiguateFromName,
  type GstRegistration,
} from '../services/businessLoan.service';

/**
 * Business Loan — branches off homeLoan.ts's 'product' step, right after the full, real identity
 * chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent — see personalLoan.ts's doc comment
 * and flows/index.ts for the shared architecture notes). ctx.answers.name/mobile/pan/segment/
 * creditScore are already real by this point.
 *
 * Lead creation now happens IMMEDIATELY on entering this branch (`blCreateLead`, 2026-10-16 —
 * same "create the lead the moment we can" pattern as Personal Loan), using the applicant's own
 * already-verified personal PAN, not the (separate, not-yet-collected) business PAN — this gives
 * every later step a real leadId to work with, in particular the PAN-to-GST lookup below.
 *
 * `blPan` is never asked at all (2026-10-21 instruction: "we dont ask pan ever in the flow in
 * business loan") — it's always silently filled from `ctx.answers.pan`, the same personal PAN
 * already collected earlier in the shared identity chain for every customer, new or existing (see
 * `blPanAutoFill`). This flow has no concept of a separate business PAN distinct from the
 * applicant's own — whatever PAN they already gave is used outright for the PAN-to-GST lookup too.
 * Business type / GST-registration are then auto-detected "on the basis of PAN" per the original
 * spec, via the real, confirmed-working POST
 * /leadflow/pantogstin (2026-10-16 — this sat unused before, with both of these asked manually
 * every time regardless). GST registration/number are never asked directly anymore either
 * (2026-10-17 instruction) — a clean miss from the lookup just means "No" (blGstRegisteredAutoFill),
 * and only the business/trading name falls back to a direct question (blBusinessName, "NA" accepted)
 * when the lookup found nothing to pull one from. Lender OFFERS/eligibility amount are still a DUMMY
 * local calculation (no real business-loan BRE exists yet).
 */
function isBusinessLoan(ctx: StepContext): boolean {
  return ctx.answers.product === 'Business Loan';
}

/** Gates every step from blBusinessType onward — false once the business PAN's 4th character
 * identifies an entity type we have no journey for yet (HUF/AOP/Trust/Government/Body of
 * Individuals/Local authority — none of these have a BUSINESS_TYPES option or a confirmed
 * PROFESSION_TYPE_ID, unlike individual/partnership/company). True before blPan is even answered,
 * so it never blocks the earlier steps. */
function isSupportedBusinessEntity(ctx: StepContext): boolean {
  const pan = ctx.answers.blPan as string | undefined;
  if (!pan) return true;
  return panEntityCategory(pan) !== 'unsupported';
}

/** Business Loan doesn't work for a salaried customer at all (2026-10-17 instruction). The
 * `product` step's own options already hide "Business Loan" for them, so this is only the
 * defensive backstop for the (should-never-happen) case the branch is reached some other way —
 * same "stop here, give a dedicated reason" treatment as an unsupported PAN entity gets, just
 * with its own message at blResult instead of being folded into isSupportedBusinessEntity's. */
function isSalariedSegment(ctx: StepContext): boolean {
  return ctx.answers.segment === 'Salaried';
}

/** The single combined gate for everything from blBusinessType onward — true only when BOTH the
 * segment and the PAN entity type are ones Business Loan actually supports. */
function canContinueBusinessLoan(ctx: StepContext): boolean {
  return !isSalariedSegment(ctx) && isSupportedBusinessEntity(ctx);
}

/** Applies one chosen GST registration's data onto the conversation — shared by blGstLookup (the
 * single-GSTIN case, auto-applied) and blGstPrimarySelect (the multi-GSTIN case, applied once the
 * customer picks one). Entity type: constitutionOfBusiness (when pantogstin returns one we
 * recognize) is checked first since it's the most direct signal; the partner's own name-based
 * rules (2026-10-17 — "use name from PAN or GSTIN to identify exact") are the fallback for
 * 'partnership'/'company' PANs when that doesn't resolve it. Neither guessing wins -> still falls
 * through to asking the customer directly (blBusinessType's own narrowed-options question). */
// The real registered address already ends in its own pincode ("...Chhattisgarh, 492001") —
// pulling it out here means blBusinessPincode doesn't need to be asked (and re-appended,
// duplicating it) separately (2026-10-17 instruction).
const TRAILING_PINCODE_PATTERN = /(\d{6})\s*$/;

/** pantogstin's own dates are DD/MM/YYYY (e.g. "11/03/2025") — converts to the YYYY-MM-DD our own
 * date math (parseIncorporationYears) and businessloandtl's date_of_incorporation field expect. */
function ddmmyyyyToIso(value: string): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return undefined;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

async function applyGstRegistration(ctx: StepContext, reg: GstRegistration): Promise<Record<string, unknown>> {
  const detected: Record<string, unknown> = { blGstRegistered: 'Yes', blGstNumber: reg.gstin };
  if (reg.businessName) detected.blBusinessName = reg.businessName;
  if (reg.registeredOfficeAddress) {
    detected.blBusinessAddress = reg.registeredOfficeAddress;
    // Flags the address as already-complete — buildBusinessLoanSummary uses this to show it as-is
    // instead of appending a separately-asked pincode/landmark that would just duplicate what's
    // already in this string; blBusinessLandmark/blBusinessPincode's own isApplicable use it too,
    // to skip asking either at all once a full real address is already in hand.
    detected.blAddressIsGstDerived = true;
    const pincodeMatch = reg.registeredOfficeAddress.match(TRAILING_PINCODE_PATTERN);
    if (pincodeMatch) {
      detected.blBusinessPincode = pincodeMatch[1];
      const area = await pincodeService.lookupArea(pincodeMatch[1]);
      if (area) detected.blBusinessPincodeArea = area;
    }
  }
  if (reg.officeAddress) detected.blOfficeAddress = reg.officeAddress;

  // This only runs once GST was actually found, so the real constitutionOfBusiness/name wins here
  // even for an individual PAN — "Proprietorship by default" (blPanEntityClassify) only applies
  // when GST is NOT found at all; when it is found, GST's own answer is the real entity type
  // (2026-10-17 clarification — don't force Proprietorship over a real found value).
  const category = panEntityCategory(ctx.answers.blPan as string | undefined);
  const fromConstitution = reg.constitutionOfBusiness ? CONSTITUTION_TO_BUSINESS_TYPE[reg.constitutionOfBusiness] : undefined;
  const businessType = fromConstitution ?? disambiguateFromName(category, reg.businessName);
  if (businessType) detected.blBusinessType = businessType;

  // GST's own effectiveDateOfRegistration stands in for date of incorporation — not collected
  // separately as a question anymore since the API already supplies a usable date (2026-10-17
  // instruction). This is strictly the GST registration date, not necessarily the entity's actual
  // incorporation date, but it's the closest real one pantogstin provides.
  const incorporationIso = reg.gstRegistrationDate ? ddmmyyyyToIso(reg.gstRegistrationDate) : undefined;
  if (incorporationIso) {
    detected.blIncorporationDate = incorporationIso;
    detected.blYearsInBusiness = parseIncorporationYears(incorporationIso) ?? undefined;
  }

  detected.blGstLookupMatched = true;
  return detected;
}

/** "22ABLCS1773K1Z2 (Chattisgarh)" — falls back to the bare GSTIN on the rare entry with no state
 * in the response, rather than showing a dangling "()" (2026-10-17 instruction). */
function gstinOptionLabel(reg: GstRegistration): string {
  return reg.state ? `${reg.gstin} (${reg.state})` : reg.gstin;
}

function parseIncorporationYears(raw: string): number | null {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const years = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return years < 0 ? null : Math.floor(years * 10) / 10;
}

/** A recap of everything collected, shown once right before the final result (lead id + RM) —
 * same spirit as homeLoan.ts's buildProfileSummary. */
function buildBusinessLoanSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${escapeHtml(a.name as string)}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${a.mobile}`);
  if (a.blLoanAmount) lines.push(`<strong>Loan amount requested:</strong> ₹${Number(a.blLoanAmount).toLocaleString('en-IN')}`);
  if (a.blLoanPurpose) lines.push(`<strong>Loan purpose:</strong> ${a.blLoanPurpose}`);
  if (a.blPan) lines.push(`<strong>Business PAN:</strong> ${a.blPan}`);
  if (a.blBusinessName) lines.push(`<strong>Business name:</strong> ${escapeHtml(a.blBusinessName as string)}`);
  if (a.blBusinessType) lines.push(`<strong>Entity type:</strong> ${a.blBusinessType}`);
  lines.push(`<strong>GST registered:</strong> ${a.blGstRegistered}${a.blGstNumber ? ` (${a.blGstNumber})` : ''}`);
  if (a.blBusinessAddress) {
    // A GST-derived address is already complete (it ends in its own pincode) — appending a
    // separately-asked pincode/area/landmark there would just duplicate what's already in the
    // string (2026-10-17 bug fix). The manual-entry path still assembles all four parts itself,
    // since there the address text alone never included them.
    const addressLine = a.blAddressIsGstDerived
      ? escapeHtml(a.blBusinessAddress as string)
      : `${escapeHtml(a.blBusinessAddress as string)}, ${a.blBusinessPincode}${a.blBusinessPincodeArea ? ` (${escapeHtml(a.blBusinessPincodeArea as string)})` : ''} — ${escapeHtml((a.blBusinessLandmark as string) ?? '')}`;
    lines.push(`<strong>Registered address:</strong> ${addressLine}`);
  }
  if (a.blOfficeAddress) lines.push(`<strong>Office address:</strong> ${escapeHtml(a.blOfficeAddress as string)}`);
  if (a.blIndustry) lines.push(`<strong>Industry:</strong> ${a.blIndustry}`);
  if (a.blYearsInBusiness !== undefined) lines.push(`<strong>Years in business:</strong> ${a.blYearsInBusiness}`);
  if (a.blAnnualTurnover) lines.push(`<strong>Annual turnover:</strong> ₹${Number(a.blAnnualTurnover).toLocaleString('en-IN')}`);
  if (a.blAnnualProfit !== undefined) lines.push(`<strong>Annual profit:</strong> ₹${Number(a.blAnnualProfit).toLocaleString('en-IN')}`);
  if (a.blEmi !== undefined) lines.push(`<strong>Existing EMIs:</strong> ${a.blEmi ? `₹${Number(a.blEmi).toLocaleString('en-IN')}/mo` : 'None'}`);
  return `Here's what I've got so far:<br>${lines.join('<br>')}`;
}

/** Same fields as buildBusinessLoanSummary above, structured for the RM notification email instead
 * of a chat bubble (2026-10-21 instruction: "send all the info except for pan and cibil score").
 * Name/mobile are skipped — already their own generic rows in every product's RM email (see
 * email.service.ts/routes/chat.ts) — and the business PAN is deliberately left out per that same
 * instruction (CIBIL score isn't part of this flow's own answers at all, nothing to exclude there). */
export function buildBusinessLoanRmDetails(ctx: StepContext): Array<{ label: string; value: string }> {
  const a = ctx.answers;
  const rows: Array<{ label: string; value: string }> = [];
  if (a.blLoanAmount) rows.push({ label: 'Loan amount requested', value: `₹${Number(a.blLoanAmount).toLocaleString('en-IN')}` });
  if (a.blLoanPurpose) rows.push({ label: 'Loan purpose', value: a.blLoanPurpose as string });
  if (a.blBusinessName) rows.push({ label: 'Business name', value: a.blBusinessName as string });
  if (a.blBusinessType) rows.push({ label: 'Entity type', value: a.blBusinessType as string });
  rows.push({ label: 'GST registered', value: `${a.blGstRegistered}${a.blGstNumber ? ` (${a.blGstNumber})` : ''}` });
  if (a.blBusinessAddress) {
    const addressLine = a.blAddressIsGstDerived
      ? (a.blBusinessAddress as string)
      : `${a.blBusinessAddress}, ${a.blBusinessPincode}${a.blBusinessPincodeArea ? ` (${a.blBusinessPincodeArea})` : ''} — ${a.blBusinessLandmark ?? ''}`;
    rows.push({ label: 'Registered address', value: addressLine });
  }
  if (a.blOfficeAddress) rows.push({ label: 'Office address', value: a.blOfficeAddress as string });
  if (a.blIndustry) rows.push({ label: 'Industry', value: a.blIndustry as string });
  if (a.blYearsInBusiness !== undefined) rows.push({ label: 'Years in business', value: String(a.blYearsInBusiness) });
  if (a.blAnnualTurnover) rows.push({ label: 'Annual turnover', value: `₹${Number(a.blAnnualTurnover).toLocaleString('en-IN')}` });
  if (a.blAnnualProfit !== undefined) rows.push({ label: 'Annual profit', value: `₹${Number(a.blAnnualProfit).toLocaleString('en-IN')}` });
  if (a.blEmi !== undefined) rows.push({ label: 'Existing EMIs', value: a.blEmi ? `₹${Number(a.blEmi).toLocaleString('en-IN')}/mo` : 'None' });
  return rows;
}

export const businessLoanSteps: StepDefinition[] = [
  {
    // Fires the moment the customer picks Business Loan — gives every later step (in particular
    // blGstLookup) a real leadId to work with, instead of waiting for the whole profile like this
    // flow used to (2026-10-16 instruction, same pattern as Personal Loan's plCreateLead).
    id: 'blCreateLead',
    type: 'apiFetch',
    progressLabel: 'Business Loan',
    isApplicable: isBusinessLoan,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx) => {
      const lead = await businessLoanService.createLead({
        conversationId: ctx.conversationId,
        mobile: ctx.answers.mobile as string,
        email: ctx.answers.email as string,
        name: ctx.answers.name as string | undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        personalPan: ctx.answers.pan as string,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      return { blLeadId: lead.leadId, blLeadRm: lead.rm };
    },
  },
  {
    id: 'blLoanAmount',
    type: 'number',
    progressLabel: 'Business Loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'How much loan amount do you need?',
    input: () => ({ type: 'number', placeholder: 'e.g. 1000000, or 10 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 50_000) return { ok: false, error: 'Enter the loan amount you need — e.g. 1000000.' };
      // Security-review finding, 2026-10-23: no upper bound existed — same "sanity floor" reasoning
      // as homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT.
      if (v > 50_00_00_000) return { ok: false, error: "That doesn't look right — enter the loan amount you need (up to ₹50 crore)." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blLoanPurpose',
    type: 'choice',
    progressLabel: 'Business Loan',
    isApplicable: isBusinessLoan,
    botMessage: () => 'What will you use it for?',
    input: () => ({ type: 'choice', options: [...BUSINESS_LOAN_PURPOSES], layout: 'column' }),
    validate: (value, ctx) => validateChoice(ctx, 'blLoanPurpose', [...BUSINESS_LOAN_PURPOSES], value, `Which of these is it: ${BUSINESS_LOAN_PURPOSES.join(', ')}?`),
  },
  {
    // PAN is never asked again in Business Loan, full stop (2026-10-21 instruction: "we dont ask
    // pan ever in the flow in business loan take the one the customer has already entered") — by
    // the time any product branch is reached, ctx.answers.pan is already real either way (dedupe
    // match for an existing customer, or their own typed entry during the shared identity chain
    // for a new one — see homeLoan.ts's 'pan' step). blPan is just that same value under its own
    // key, so later business-PAN-specific logic (panEntityCategory, pantogstin, etc.) has something
    // to read without caring which path it came from.
    id: 'blPanAutoFill',
    type: 'message',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && !ctx.answers.blPan,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx) => ({ blPan: ctx.answers.pan }),
  },
  {
    // PAN's 4th character identifies the entity type outright (partner-confirmed table,
    // 2026-10-16) — no API needed. Individual is unambiguous (-> Proprietorship, set directly).
    // Partnership/Company are narrowed to just their 2-3 real options rather than the full
    // BUSINESS_TYPES list. Anything else (HUF/AOP/Trust/Government/Body of Individuals/Local
    // authority) has no journey built yet — isSupportedBusinessEntity stops the flow there, same
    // "not supported yet" treatment as HL/LAP's PAN-entity gate (see homeLoan.ts's isIndividualPan).
    id: 'blPanEntityClassify',
    type: 'message',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && !ctx.answers.blPanEntityClassified,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx) => {
      const category = panEntityCategory(ctx.answers.blPan as string | undefined);
      const detected: Record<string, unknown> = { blPanEntityClassified: true };
      if (category === 'individual') detected.blBusinessType = 'Proprietorship';
      const narrowed = BUSINESS_TYPE_OPTIONS_BY_CATEGORY[category];
      if (narrowed) detected.blBusinessTypeOptions = narrowed;
      return detected;
    },
  },
  {
    // Real, confirmed-working lookup (POST /leadflow/pantogstin, 2026-10-16) — auto-detects GST
    // registration/number and business entity type from the business PAN. blGstRegistered/
    // blGstNumber are never asked interactively anymore (2026-10-17 instruction) — a clean miss
    // here just means "no GST", filled in silently by blGstRegisteredAutoFill below. Its own
    // constitutionOfBusiness match can resolve blPanEntityClassify's Partnership/LLP or
    // Private/Public/OPC ambiguity outright, skipping blBusinessType's narrowed question too.
    id: 'blGstLookup',
    type: 'apiFetch',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx) => {
      const result = await businessLoanService.fetchGstFromPan(ctx.answers.blLeadId as string, ctx.answers.blPan as string, ctx.answers.finfinityAccessToken as string | undefined);
      if (!result || result.registrations.length === 0) return {};
      // More than one GSTIN on this PAN — ask which is primary rather than silently assuming the
      // first (2026-10-17 instruction) — blGstPrimarySelect below handles applying it once chosen.
      if (result.registrations.length > 1) return { blGstRegistrations: result.registrations };
      return applyGstRegistration(ctx, result.registrations[0]);
    },
  },
  {
    // Only asked when the PAN has more than one GSTIN registered — see blGstLookup above.
    id: 'blGstPrimarySelect',
    type: 'choice',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && Array.isArray(ctx.answers.blGstRegistrations) && !ctx.answers.blGstNumber,
    botMessage: () => "You have more than one GST registration on this PAN — which one is your primary GSTIN?",
    // Labelled with each registration's state/city (2026-10-17 instruction) so the customer can
    // actually tell otherwise-identical-looking GSTIN strings apart — falls back to the bare GSTIN
    // on the rare entry with no state in the response.
    input: (ctx) => ({
      type: 'choice',
      options: (ctx.answers.blGstRegistrations as GstRegistration[]).map((r) => gstinOptionLabel(r)),
      layout: 'column',
    }),
    validate: (value, ctx) => {
      const options = (ctx.answers.blGstRegistrations as GstRegistration[]).map((r) => gstinOptionLabel(r));
      return validateChoice(ctx, 'blGstPrimarySelect', options, value, 'Which GSTIN is your primary one?');
    },
    onAnswer: (parsed, ctx) => {
      const registrations = ctx.answers.blGstRegistrations as GstRegistration[];
      const chosen = registrations.find((r) => gstinOptionLabel(r) === parsed) ?? registrations[0];
      return applyGstRegistration(ctx, chosen);
    },
  },
  {
    // Only shown when a GST lookup actually found something — a silent auto-fill with no
    // acknowledgement would look like the bot skipped questions for no reason.
    id: 'blGstLookupSummary',
    type: 'message',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && Boolean(ctx.answers.blGstLookupMatched),
    botMessage: (ctx) => {
      const lines: string[] = [];
      if (ctx.answers.blBusinessName) lines.push(`<strong>Business name:</strong> ${ctx.answers.blBusinessName}`);
      if (ctx.answers.blBusinessType) lines.push(`<strong>Entity type:</strong> ${ctx.answers.blBusinessType}`);
      if (ctx.answers.blGstNumber) lines.push(`<strong>GST number:</strong> ${ctx.answers.blGstNumber}`);
      if (ctx.answers.blBusinessAddress) lines.push(`<strong>Registered address:</strong> ${ctx.answers.blBusinessAddress}`);
      if (ctx.answers.blOfficeAddress) lines.push(`<strong>Office address:</strong> ${ctx.answers.blOfficeAddress}`);
      // Was "let me know later if anything needs correcting" — a false promise, since there's no
      // chat-text edit path at all (the "change my X in chat" mechanism referenced in
      // editableFields.ts's own doc comment was never actually built — only the profile-panel
      // pencil exists). Points at the real, only mechanism instead (2026-10-17 instruction).
      return `Found this from your PAN:<br>${lines.join('<br>')}<br><br>Only the registered address can be corrected, from the details panel (on the right on desktop, or the edit icon at the top on mobile).`;
    },
    input: () => ({ type: 'none' }),
  },
  {
    // Only asked when the PAN-to-GST lookup found nothing to auto-fill a business name from
    // (2026-10-17 instruction) — "NA" is accepted as a real answer for a business with no trading
    // name of its own, same as any other minimum-length text field.
    id: 'blBusinessName',
    type: 'text',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blGstLookupMatched && !ctx.answers.blBusinessName,
    botMessage: () => "What's your business / trading name? Enter NA if it doesn't have one.",
    input: () => ({ type: 'text', placeholder: 'Business or trading name, or NA' }),
    validate: (value) => {
      const v = (value || '').trim();
      if (v.length < 2) return { ok: false, error: "Enter your business name, or NA if it doesn't have one." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blBusinessType',
    type: 'choice',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blBusinessType,
    botMessage: (ctx) => {
      const options = (ctx.answers.blBusinessTypeOptions as string[] | undefined) ?? [...BUSINESS_TYPES];
      if (options.length < BUSINESS_TYPES.length) return `Based on your PAN, this looks like a ${options.join(' or ')} — which one is it?`;
      return 'What type of business is it?';
    },
    input: (ctx) => ({ type: 'choice', options: (ctx.answers.blBusinessTypeOptions as string[] | undefined) ?? [...BUSINESS_TYPES], layout: 'column' }),
    validate: (value, ctx) => {
      const options = (ctx.answers.blBusinessTypeOptions as string[] | undefined) ?? [...BUSINESS_TYPES];
      return validateChoice(ctx, 'blBusinessType', options, value, `Which of these is it: ${options.join(', ')}?`);
    },
  },
  {
    // Never asked interactively anymore (2026-10-17 instruction: "dont ask gst if not found from
    // pantogst") — GST registration/number now comes exclusively from the real pantogstin lookup
    // above. When it found nothing, that itself IS the answer: the business has no GST registered
    // under this PAN, full stop, so this silently fills 'No' rather than asking the customer to
    // confirm a thing we already just checked for real.
    id: 'blGstRegisteredAutoFill',
    type: 'message',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blGstRegistered,
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: () => ({ blGstRegistered: 'No' }),
  },
  {
    id: 'blBusinessAddress',
    type: 'text',
    progressLabel: 'Business Loan',
    // Skipped when GST already supplied a real registered office address (see
    // applyGstRegistration) — only asked manually when there's no GST data to get one from.
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blBusinessAddress,
    botMessage: () => "What's your business address?",
    input: () => ({ type: 'text', placeholder: 'Shop/unit, street, area' }),
    validate: (value) => validateAddress(value),
  },
  {
    id: 'blBusinessLandmark',
    type: 'text',
    progressLabel: 'Business Loan',
    // Skipped once GST already supplied a full real address (no landmark field exists in that
    // response at all, and a complete postal address makes a landmark redundant anyway) — only
    // asked when the address itself was typed in manually (2026-10-17 instruction).
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blAddressIsGstDerived,
    botMessage: () => 'Any landmark near the business?',
    input: () => ({ type: 'text', placeholder: 'e.g. Near City Mall' }),
    validate: (value) => validateLandmark(value),
  },
  {
    id: 'blBusinessPincode',
    type: 'text',
    progressLabel: 'Business Loan',
    // Skipped when GST's registered address already supplied one — see applyGstRegistration's
    // trailing-pincode extraction (2026-10-17 instruction: asking again just duplicated it).
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && !ctx.answers.blBusinessPincode,
    botMessage: () => 'And the pincode for that address?',
    input: () => ({ type: 'text', placeholder: 'e.g. 400001', maxLength: 6 }),
    validate: (value) => validatePincode(value),
    onAnswer: async (parsed, ctx) => {
      const area = await pincodeService.lookupArea(parsed as string);
      return area ? { blBusinessPincodeArea: area } : undefined;
    },
  },
  {
    id: 'blBusinessPincodeConfirm',
    type: 'message',
    progressLabel: 'Business Loan',
    // Also skipped for a GST-derived address — the "Found your ... registered address ..." summary
    // already showed the full real address, so confirming the pincode's area again right after is
    // redundant (2026-10-17 instruction).
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && Boolean(ctx.answers.blBusinessPincodeArea) && !ctx.answers.blAddressIsGstDerived,
    botMessage: (ctx) => `Got it — ${ctx.answers.blBusinessPincode} is ${escapeHtml(ctx.answers.blBusinessPincodeArea as string)}.`,
    input: () => ({ type: 'none' }),
  },
  {
    id: 'blIndustry',
    type: 'choice',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => 'Which industry is the business in?',
    input: () => ({ type: 'choice', options: [...INDUSTRY_TYPES], layout: 'row' }),
    validate: (value, ctx) => validateChoice(ctx, 'blIndustry', [...INDUSTRY_TYPES], value, `Which of these is it: ${INDUSTRY_TYPES.join(', ')}?`),
  },
  {
    // Only for a registered entity (Partnership/LLP/Company) — a real date of incorporation
    // exists for these, so years-in-business is calculated from it. A proprietorship (PAN's 4th
    // letter P) has no such date — see blYearsInBusinessManual below instead (2026-10-17 instruction).
    id: 'blIncorporationDate',
    type: 'text',
    progressLabel: 'Business Loan',
    // Also skipped once GST's own effectiveDateOfRegistration already supplied one (see
    // applyGstRegistration) — only asked when GST data wasn't available at all.
    isApplicable: (ctx) =>
      isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && panEntityCategory(ctx.answers.blPan as string | undefined) !== 'individual' && !ctx.answers.blIncorporationDate,
    botMessage: () => "What's the business's date of incorporation?",
    input: () => ({ type: 'date', max: new Date().toISOString().slice(0, 10) }),
    validate: (value) => {
      const years = parseIncorporationYears((value || '').trim());
      if (years === null) return { ok: false, error: 'Pick a valid date of incorporation.' };
      return { ok: true, parsed: (value || '').trim() };
    },
    onAnswer: (parsed) => ({ blYearsInBusiness: parseIncorporationYears(parsed as string) ?? undefined }),
  },
  {
    // Proprietorship (PAN's 4th letter P) — no incorporation date exists to calculate this from,
    // so ask directly instead (2026-10-17 instruction).
    id: 'blYearsInBusinessManual',
    type: 'number',
    progressLabel: 'Business Loan',
    // Also skipped when GST's effectiveDateOfRegistration already derived this (a proprietor can
    // still have GST registered — applyGstRegistration doesn't only run for registered entities).
    isApplicable: (ctx) =>
      isBusinessLoan(ctx) && canContinueBusinessLoan(ctx) && panEntityCategory(ctx.answers.blPan as string | undefined) === 'individual' && ctx.answers.blYearsInBusiness === undefined,
    botMessage: () => 'How many years has your business been operating?',
    input: () => ({ type: 'number', placeholder: 'e.g. 5' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: "Enter the number of years, e.g. 5 (or 0 if it's under a year)." };
      // Security-review finding, 2026-10-23: an absurd value here (e.g. a typo like 9999999) reached
      // the date math in onAnswer below unchecked — setFullYear()/toISOString() can throw a
      // RangeError on a date far enough outside JS's representable range. 150 years comfortably
      // covers any real business's age with room to spare.
      if (v > 150) return { ok: false, error: 'Enter the number of years, e.g. 5 (up to 150).' };
      return { ok: true, parsed: v };
    },
    // businessloandtl's date_of_incorporation is a real required field on the live API — a
    // proprietorship has no actual incorporation date to send, but leaving it undefined made every
    // save for this branch fail outright with a generic "Error in saving"/CUSTSRV143 (found
    // 2026-10-17 from a live failure). Backs into an approximate one from the years-in-business
    // answer instead — close enough for a field the real BRE only uses for vintage, not displayed
    // back to the customer anywhere.
    onAnswer: (parsed) => {
      const years = parsed as number;
      const approxDate = new Date();
      approxDate.setFullYear(approxDate.getFullYear() - Math.floor(years));
      approxDate.setDate(approxDate.getDate() - Math.round((years % 1) * 365.25));
      return { blYearsInBusiness: years, blIncorporationDate: approxDate.toISOString().slice(0, 10) };
    },
  },
  {
    id: 'blAnnualTurnover',
    type: 'number',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => "What's your annual turnover?",
    input: () => ({ type: 'number', placeholder: 'e.g. 5000000, or 50 lakh' }),
    validate: (value) => {
      const v = parseAmount(value);
      if (!v || v < 1) return { ok: false, error: 'Enter your annual turnover — e.g. 5000000.' };
      // Security-review finding, 2026-10-23: no upper bound existed — same "sanity floor" reasoning
      // as homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT.
      if (v > 1_00_000_00_00_000) return { ok: false, error: "That doesn't look right — enter your annual turnover (up to ₹1,00,000 crore)." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blAnnualProfit',
    type: 'number',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => "And your annual profit?",
    input: () => ({ type: 'number', placeholder: 'e.g. 800000, or 8 lakh' }),
    validate: (value, ctx) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: 'Enter your annual profit — e.g. 800000.' };
      const turnover = Number(ctx.answers.blAnnualTurnover);
      if (turnover && v > turnover) return { ok: false, error: 'Annual profit cannot be more than annual turnover.' };
      return { ok: true, parsed: v };
    },
  },
  {
    // Was never asked at all (2026-10-17 fix) — every other product's flow collects existing EMIs
    // alongside income/turnover, Business Loan just never did.
    id: 'blEmi',
    type: 'number',
    progressLabel: 'Business Loan',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => 'Do you currently have any other loan EMIs?',
    hint: () => 'Say "no" if you don\'t have any.',
    input: () => ({ type: 'number', placeholder: "e.g. 8000, or 'no'" }),
    validate: (value) => {
      const v = parseAmount(value);
      if (v === null || v < 0) return { ok: false, error: "Enter the amount, or say 'no' if you don't have any." };
      // Security-review finding, 2026-10-23: no upper bound existed — same "sanity floor" reasoning
      // as homeLoan.ts's MAX_SANE_MONTHLY_AMOUNT.
      if (v > 1_00_00_000) return { ok: false, error: "That doesn't look right — enter the EMI amount (up to ₹1 crore/month)." };
      return { ok: true, parsed: v };
    },
  },
  {
    id: 'blProfileSummary',
    type: 'message',
    progressLabel: 'Your eligibility',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: (ctx) => buildBusinessLoanSummary(ctx),
    input: () => ({ type: 'none' }),
  },
  {
    // Saves the full collected profile onto the lead blCreateLead already made at the top of this
    // flow — the lead itself has existed since the branch started; this just fills it in.
    id: 'blSaveDetails',
    type: 'apiFetch',
    progressLabel: 'Your eligibility',
    isApplicable: (ctx) => isBusinessLoan(ctx) && canContinueBusinessLoan(ctx),
    botMessage: () => null,
    input: () => ({ type: 'none' }),
    onAnswer: async (_parsed, ctx) => {
      await businessLoanService.saveDetails({
        leadId: ctx.answers.blLeadId as string,
        loanAmount: Number(ctx.answers.blLoanAmount),
        loanPurpose: ctx.answers.blLoanPurpose as string,
        businessPan: ctx.answers.blPan as string,
        businessType: ctx.answers.blBusinessType as string,
        businessName: ctx.answers.blBusinessName as string | undefined,
        gstNumber: ctx.answers.blGstNumber as string | undefined,
        businessAddress: ctx.answers.blBusinessAddress as string,
        businessPincode: ctx.answers.blBusinessPincode as string,
        businessLandmark: ctx.answers.blBusinessLandmark as string | undefined,
        industry: ctx.answers.blIndustry as string,
        incorporationDate: ctx.answers.blIncorporationDate as string,
        token: ctx.answers.finfinityAccessToken as string | undefined,
      });
      return {};
    },
  },
  {
    id: 'blResult',
    type: 'result',
    progressLabel: 'Your eligibility',
    isApplicable: isBusinessLoan,
    botMessage: (ctx) => {
      const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
      if (payload?.segmentNotSupported) return "Business Loan isn't available for salaried applicants — it's only for business owners and self-employed professionals.";
      if (payload?.entityNotSupported) return "We don't have a journey for entities yet — this product is currently only available for individuals, partnerships/LLPs, and companies.";
      const name = (ctx.answers.name as string | undefined)?.split(' ')[0];
      const greeting = name ? `All done, ${name} — your business loan application is in.` : 'All done — your business loan application is in.';
      if (!payload?.leadCreated) return greeting;
      return `${greeting}<br><br>${leadCreatedMessage(payload.leadId, payload.rm)}`;
    },
    input: () => ({ type: 'none' }),
    onAnswer: (_parsed, ctx): { resultPayload: EligibilityResultPayload } => {
      if (isSalariedSegment(ctx) || !isSupportedBusinessEntity(ctx)) {
        return {
          resultPayload: {
            eligible: false,
            entityNotSupported: !isSalariedSegment(ctx),
            segmentNotSupported: isSalariedSegment(ctx),
            name: ctx.answers.name as string | undefined,
            product: 'Business Loan',
            loanType: 'Business Loan',
            segment: ctx.answers.segment as EligibilityResultPayload['segment'],
            creditScore: ctx.answers.creditScore as number | undefined,
            rm: ctx.answers.blLeadRm as { name: string; phone: string; email: string },
            leadCreated: false,
          },
        };
      }

      // Business Loan never computes eligibility/offers — no real BL BRE exists, and the spec for
      // this product is lead capture only (2026-10-16 direct instruction: "we never calculate
      // eligibility, just capture lead" — same minimal spirit as Loan Against Securities).
      const resultPayload: EligibilityResultPayload = {
        eligible: true,
        name: ctx.answers.name as string | undefined,
        product: 'Business Loan',
        loanType: 'Business Loan',
        segment: ctx.answers.segment as EligibilityResultPayload['segment'],
        creditScore: ctx.answers.creditScore as number | undefined,
        rm: ctx.answers.blLeadRm as { name: string; phone: string; email: string },
        leadId: ctx.answers.blLeadId as string,
        leadCreated: true,
      };
      return { resultPayload };
    },
  },
];
