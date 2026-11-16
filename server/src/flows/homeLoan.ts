import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, COLLATERAL_TYPES, LOAN_TYPES, PRODUCT_OPTIONS, PROPERTY_TYPES, SEGMENTS, type EligibilityResultPayload } from '@builder-chatbot/shared';
import type { Answers, FlowDefinition, StepContext } from '../flow-engine/types';
import { encryptPii, hmacLookup, maskMobile, maskPan } from '../lib/crypto';
import { escapeHtml } from '../lib/escapeHtml';
import { logger } from '../lib/logger';
import type { SemanticHint } from '../lib/matchChoice';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { UserFacingError } from '../lib/userFacingError';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { bureauService, realBureauApi, realBureauFlowEnabled, type BureauPull } from '../services/bureau.service';
import { customerService } from '../services/customer.service';
import { dedupeService, type DuplicateMatch } from '../services/dedupe.service';
import { eligibilityService } from '../services/eligibility.service';
import { homeLoanEligibilityService, mapSegmentToHlEmploymentType, mapPropertyTypeToHl, HL_LENDER_DISPLAY_NAME, type HlEligibilityFacts, type HlLenderEligibility } from '../services/homeLoanEligibility.service';
import { lenderNamesMatch } from './personalLoan';
import { ensureLeadOnce, leadService, markLeadFinancialsSynced, PRODUCT_CODE } from '../services/lead.service';
import { panService } from '../services/pan.service';
import { pincodeService } from '../services/pincode.service';
import { sendLeadCreatedWebhook } from '../services/webhook.service';
import { smsService, enforceDuplicateVerifyRateLimit } from '../services/sms.service';
import { rememberIdentity } from '../services/identity.service';
import { rememberProfile } from '../services/profile.service';
import { statusService } from '../services/status.service';
import { generateLeadId, pickRm } from './rm';

function isEligibilityIntent(answers: Answers): boolean {
  return answers.intent === CHECK_ELIGIBILITY;
}

/** Everything from 'loanType' onward in this file only ever runs for Home loan/Loan against
 * property — Personal/Gold/Business loan and Loan Against Securities branch off into their own
 * short flows right after 'product' (see flows/index.ts) and never reach these steps. Before
 * 'product' is actually answered, ctx.answers.product is still undefined, so these stay counted as
 * applicable (matching the historical "assume Home loan until told otherwise" progress count) —
 * they only drop out once a *different* product is actually chosen, which is what keeps the
 * progress bar's total from being inflated by Home loan-only steps for those other products. */
function isHomeLoanOrLap(answers: Answers): boolean {
  return !answers.product || answers.product === 'Home loan' || answers.product === 'Loan Against Property';
}

/** PAN's 4th character is the Income Tax Department's own entity-type code — 'P' is an individual;
 * every other code ('C' company, 'F' firm/LLP, 'H' HUF, 'A' association of persons, 'T' trust, 'G'
 * government, 'B' body of individuals, 'L' local authority) is some kind of non-individual entity.
 * Home Loan/LAP only have an individual-applicant journey built — there's no eligibility logic for
 * an entity PAN yet, so these two products stop and say so rather than walking a non-individual
 * applicant through the full income/property questionnaire for an answer we can never give them
 * (2026-10-16 direct instruction — table confirmed the P/C/F/H/A/T code mapping). */
function isIndividualPan(pan: string | undefined): boolean {
  return !pan || pan.charAt(3).toUpperCase() === 'P';
}

// 2026-11-03 instruction: "built this but dont use it anywhere yet i will tell u when to use it" —
// the fuzzy name-match feature below (panNameMismatchChoice, namesLooselyMatch) is fully wired but
// switched off here. Flip to true when told to turn it on; nothing else needs to change.
const HOME_LOAN_NAME_MISMATCH_CHECK_ENABLED = false;

/** A partner's own launch-token `name` (per their own journey) vs. the real PAN-verified name —
 * deliberately NOT an exact match, since the single most common real mismatch is just an omitted
 * middle name (e.g. "Rounak Chadha" prefilled vs. "Rounak Kumar Chadha" on the actual PAN record —
 * same person, nothing wrong). Every meaningful word in the SHORTER name must appear somewhere in
 * the longer one; if even one doesn't, treat it as a real mismatch worth asking about rather than
 * silently assuming it's fine (2026-11-03 instruction: "if its thoda bhi same let it, if its
 * different then prompt"). Not real NLP — good enough to be indicative, same spirit as
 * lenderNamesMatch/reasonsOverlap in personalLoan.ts. */
function namesLooselyMatch(a: string, b: string): boolean {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean));
  const tokensA = tokens(a);
  const tokensB = tokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return true; // nothing real to compare — don't block on it
  const [shorter, longer] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  for (const word of shorter) if (!longer.has(word)) return false;
  return true;
}

// Security-review finding, 2026-10-23: there was no minimum-age check anywhere for Home Loan/LAP —
// the real DOB (from the PAN lookup) was only ever used to DISPLAY an age on the profile summary,
// never to gate anything. 18 is the standard contracting-age floor for a lending product in India.
const MIN_APPLICANT_AGE_YEARS = 18;

/** Business Loan isn't offered to a salaried customer at all (2026-10-17 instruction) — hidden
 * from the 'product' choices outright rather than offered and rejected deeper into its own flow
 * (businessLoan.ts's isSalariedSegment is the defensive backstop for that branch regardless).
 * Personal Loan is the mirror image (2026-10-21 instruction) — its real lender eligibility rules
 * (Poonawalla/Tata/Unity) only apply to salaried applicants, so it's hidden for Business owner/
 * Self-employed professional the same way, with personalLoan.ts's isNonSalariedSegment as the
 * same kind of defensive backstop. */
function productOptionsFor(ctx: StepContext): string[] {
  const segment = ctx.answers.segment;
  return PRODUCT_OPTIONS.filter((option) => {
    if (option === 'Business Loan' && segment === 'Salaried') return false;
    if (option === 'Personal Loan' && segment && segment !== 'Salaried') return false;
    return true;
  });
}

/** Both intents need a verified identity before we act on their mobile number — eligibility needs
 * it for the dedupe/PAN/bureau calls that follow; "check an existing application" needs it before
 * lookupApplicationStatus reveals a real application's status against a number nobody has proven
 * they own yet (previously nothing gated this at all — anyone who knew a customer's mobile number
 * could ask for their application status with zero verification). */
function needsIdentityOtp(answers: Answers): boolean {
  return isEligibilityIntent(answers) || answers.intent === CHECK_EXISTING_APPLICATION;
}

/** Shared by every OTP-entry step's onAnswer — verifies the code and maps the two known failure
 * modes to the same customer-safe messages, so each call site doesn't have to repeat this. */
async function verifyOtpOrThrow(conversationId: string, code: string) {
  let result: { ok: boolean; remoteCustomerId?: number; accessToken?: string; refreshToken?: string };
  try {
    result = await smsService.verifyOtp(conversationId, code);
  } catch (err) {
    // Security-review finding, 2026-10-23: every thrown error here used to become "Too many
    // incorrect attempts" — including a genuine network/API error that had nothing to do with the
    // customer's attempt count, telling them it was their fault when it wasn't. 'otp_locked' (thrown
    // by sms.service.ts for the real lockout case) is the only one that message actually describes.
    if (err instanceof Error && err.message === 'otp_locked') {
      throw new Error('Too many incorrect attempts. Please request a new OTP.');
    }
    throw new Error('Something went wrong verifying your OTP. Please try again.');
  }
  if (!result.ok) throw new Error('Incorrect OTP. Please try again.');
  return result;
}

/** Called every time identity gets (re-)verified — lets a "check eligibility again" click within
 * the next 10 minutes skip straight past mobile+OTP (see identity.service.ts and beginNewSession
 * in routes/chat.ts). Reuses the SAME token across re-verifications in one conversation (e.g. the
 * later bureau-consent OTP) rather than handing the widget a new one to store each time. */
async function establishIdentitySession(
  ctx: StepContext,
  mobile: string,
  accessToken: string | undefined,
  refreshToken: string | undefined,
  remoteCustomerId: number | undefined,
): Promise<{ identityToken: string }> {
  const identityToken = await rememberIdentity(
    { mobile, finfinityAccessToken: accessToken, finfinityRefreshToken: refreshToken, remoteCustomerId },
    ctx.answers.identityToken as string | undefined,
  );
  // Written alongside identityToken above (same data, same moment) rather than having one token
  // delegate to the other — see profile.service.ts's own doc comment for why. This is what lets a
  // DIFFERENT product, opened within the next 10 minutes, skip mobile+OTP too.
  void rememberProfile(mobile, { finfinityAccessToken: accessToken, finfinityRefreshToken: refreshToken, remoteCustomerId });
  return { identityToken };
}

function isBT(answers: Answers): boolean {
  return String(answers.loanType || '').includes('Balance transfer');
}

/** Property is already identified for balance transfers and LAP-against-owned-property; still needs asking for fresh purchases. */
function propertyAlreadyIdentified(answers: Answers): boolean {
  return isBT(answers) || answers.loanType === 'Loan Against Property (LAP)';
}

export function calcAge(dobIso: string): number {
  const dob = new Date(dobIso);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

/** A first name for a friendly greeting — pulled from the real (unmasked) name where we have it,
 * since a first name alone isn't the sensitive part; falls back to the masked display name. */
/** Always used straight inside an innerHTML'd botMessage — escaped here once so every call site
 * doesn't have to remember to (the name ultimately traces back to dedupe/PAN-lookup, an external
 * API response, not something to trust verbatim in HTML). */
function firstName(ctx: StepContext): string {
  const name = (ctx.answers.fullName as string | undefined) ?? (ctx.answers.name as string | undefined) ?? '';
  return escapeHtml(name.split(' ')[0]);
}

function formatDob(dobIso: string): string {
  return new Date(dobIso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Shared by 'profileFound' and the duplicate-match-adopted equivalent below — same "here's what
 * we have on file" summary either way, since both cases mean the customer is genuinely a known
 * existing customer by the time this renders, just reached via a different path. Exported for
 * chat.ts's cold-resume path (2026-11-13) — see its own comment for why. */
export function renderFoundProfileSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${escapeHtml(a.name as string)}`);
  if (a.pan) lines.push(`<strong>PAN:</strong> ${maskPan(a.pan as string)}`);
  // A non-individual PAN's "dob" field is really its date of registration/incorporation — showing
  // it as a birth date + age would be nonsensical for an entity (2026-10-17 instruction).
  if (a.dob) {
    lines.push(
      isIndividualPan(a.pan as string | undefined)
        ? `<strong>DOB:</strong> ${formatDob(a.dob as string)} (age ${calcAge(a.dob as string)})`
        : `<strong>Date of incorporation:</strong> ${formatDob(a.dob as string)}`,
    );
  }
  if (a.email) lines.push(`<strong>Email:</strong> ${escapeHtml(a.email as string)}`);
  if (a.pincode) lines.push(`<strong>Pincode:</strong> ${a.pincode}`);
  if (a.segment) lines.push(`<strong>Employment:</strong> ${a.segment}`);
  if (a.creditScore) lines.push(`<strong>CIBIL score:</strong> ${a.creditScore}`);
  return `Hi ${firstName(ctx)}, good to have you back — here's what we have on file:<br>${lines.join('<br>')}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

// Common providers people actually type — used only to catch near-miss typos ("gma.com"), never
// to whitelist/reject legitimate domains outright.
const COMMON_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'rediffmail.com',
  'icloud.com',
  'protonmail.com',
  'live.com',
  'aol.com',
];

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Returns the likely-intended domain if `domain` looks like a typo of a common provider
 * (e.g. "gma.com" -> "gmail.com"), or null if it doesn't look suspicious. */
function suggestedEmailDomain(domain: string): string | null {
  if (COMMON_EMAIL_DOMAINS.includes(domain)) return null;
  for (const known of COMMON_EMAIL_DOMAINS) {
    if (Math.abs(domain.length - known.length) > 2) continue;
    if (levenshtein(domain, known) <= 2) return known;
  }
  return null;
}

// "I own a shop" doesn't lexically overlap with "Business owner" at all — these catch the intent
// so the bot asks "did you mean X?" instead of declining as unrelated.
// A sanity floor, not a business eligibility rule (that's FOIR, computed separately) — just
// rejects obvious typos/joke values like "6" so eligibility math never runs on nonsense input.
const MIN_SANE_INCOME = 5_000;
const MIN_PROPERTY_VALUE = 500_000; // ₹5 lakh floor — same "sanity, not a business rule" reasoning as MIN_SANE_INCOME
// Security-review finding, 2026-10-23: there was no upper bound at all on income/EMI/loan amount —
// a mistyped or abusive value (an extra zero, a copy-paste accident) sailed straight through to
// real Finfinity calls. Same "sanity floor, not a business rule" spirit as MIN_SANE_INCOME above,
// just on the other end — generous enough that no real applicant should ever hit it.
const MAX_SANE_MONTHLY_AMOUNT = 1_00_00_000; // ₹1 crore/month — covers income and EMI
const MAX_SANE_PROPERTY_VALUE = 500_00_00_000; // ₹500 crore

const SEGMENT_HINTS: SemanticHint[] = [
  { pattern: /\b(shop|store|trading|vendor|own(er)? of a|my business|entrepreneur)\b/i, option: 'Business owner' },
  { pattern: /\b(freelance|consultant|doctor|lawyer|architect|\bca\b|chartered accountant|private practice)\b/i, option: 'Self-employed professional' },
  { pattern: /\b(salary|job|company|employer|working at|working for)\b/i, option: 'Salaried' },
];

/** A quick recap of what's been collected, shown once right before the eligibility computation —
 * lets the customer catch a mistake before we compute anything, and makes it visible that the bot
 * actually understood what they typed rather than just silently moving on. By the time this
 * renders, the PAN/bureau-consent OTP has already been verified (it's the step right before this
 * one in both branches), so there's no reason left to show the masked name/PAN here — use the
 * real values. */
function buildProfileSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];

  const fullName = (a.fullName as string | undefined) ?? (a.name as string | undefined);
  if (fullName) lines.push(`<strong>Name:</strong> ${escapeHtml(fullName)}`);
  if (a.mobile) lines.push(`<strong>Mobile:</strong> +91 ${maskMobile(a.mobile as string)}`);
  if (a.pan) lines.push(`<strong>PAN:</strong> ${maskPan(a.pan as string)}`);
  if (a.creditScore) lines.push(`<strong>CIBIL score:</strong> ${a.creditScore}`);
  if (a.email) lines.push(`<strong>Email:</strong> ${escapeHtml(a.email as string)}`);
  if (a.segment) lines.push(`<strong>Employment:</strong> ${a.segment}`);
  if (a.pincode) lines.push(`<strong>Pincode:</strong> ${a.pincode}`);
  if (a.product) lines.push(`<strong>Product:</strong> ${a.product}${a.loanType ? ` — ${a.loanType}` : ''}`);
  if (a.income) lines.push(`<strong>Monthly income:</strong> ₹${Number(a.income).toLocaleString('en-IN')}`);
  lines.push(`<strong>Existing EMIs:</strong> ${a.emi ? `₹${Number(a.emi).toLocaleString('en-IN')}/month` : 'None'}`);
  if (a.propertyType) lines.push(`<strong>Property type:</strong> ${a.propertyType}`);
  if (a.propertyValue) lines.push(`<strong>Property value:</strong> ₹${Number(a.propertyValue).toLocaleString('en-IN')}`);
  if (a.collateralType) lines.push(`<strong>Collateral type:</strong> ${a.collateralType}`);
  if (a.occupancy) lines.push(`<strong>Occupancy:</strong> ${a.occupancy}`);
  // Property not yet identified (propertyGate === 'Not yet') means none of the three rows above
  // ever get asked/shown — without an explicit line here the summary just silently said nothing
  // about the property at all (2026-10-31 direct instruction: flag this case explicitly).
  if (a.propertyGate === 'Not yet' && !propertyAlreadyIdentified(a)) {
    lines.push(`<strong>Property identified:</strong> Not yet`);
  }

  return `Here's what I've got so far:<br>${lines.join('<br>')}<br><br>Let me check your eligibility across lenders now.`;
}

// Not collected anywhere in this flow (the real getcustomeroffers call needs none of these either
// — see RealEligibilityService's own comment on how it's keyed purely by leadid) — same "fixed
// stand-in, not a real collected value" spirit as personalLoan.ts's PL_PRECHECK_TENURE_MONTHS.
// Requested amount is set to 80% of the property value (a customer applying for a purchase loan
// typically wants close to the max LTV-serviceable amount) purely to pick the right LTV slab in
// our own pre-check's flat LTV table — it never gates eligibility there either way (see that
// project's "never reject on requested amount" standing rule).
const HL_PRECHECK_TENURE_MONTHS = 240;

function buildHlPrecheckFacts(ctx: StepContext): HlEligibilityFacts {
  const a = ctx.answers;
  const propertyValue = Number(a.propertyValue) || 0;
  return {
    cibilScore: Number(a.creditScore) || 0,
    monthlyIncome: Number(a.income) || 0,
    employmentType: mapSegmentToHlEmploymentType(a.segment as string | undefined),
    age: a.dob ? calcAge(a.dob as string) : 0,
    pincode: (a.pincode as string) ?? '',
    propertyValue,
    loanAmountRequested: Math.round(propertyValue * 0.8),
    tenureMonths: HL_PRECHECK_TENURE_MONTHS,
    propertyType: mapPropertyTypeToHl(a.propertyType as string | undefined),
    existingMonthlyEmi: Number(a.emi) || 0,
  };
}

/** Fired-and-forgotten (never awaited by the customer-facing path) right after the real
 * getcustomeroffers call computes offers — runs our own standalone Home Loan BRE
 * (homeLoanEligibility.service.ts) on the same facts purely for comparison, and persists both so
 * they can be reviewed later to calibrate/improve our own BRE. Same discipline as
 * personalLoan.ts's runOwnBreComparison for Personal Loan — never shown to the customer, never
 * affects what they see or which offers they can pick.
 *
 * `realChainResults` here is only the ELIGIBLE side — see HlBreComparison's own schema comment for
 * why getcustomeroffers's rejected_lender_list isn't available at this layer today. */
async function runOwnHlBreComparison(ctx: StepContext, leadId: string | undefined, realOffers: EligibilityResultPayload['offers']): Promise<void> {
  try {
    const facts = buildHlPrecheckFacts(ctx);
    const ownBreResults: HlLenderEligibility[] = await homeLoanEligibilityService.checkAll(facts);
    await prisma.hlBreComparison.create({
      data: {
        conversationId: ctx.conversationId,
        leadId,
        facts: facts as unknown as Prisma.InputJsonValue,
        realChainResults: (realOffers ?? []) as unknown as Prisma.InputJsonValue,
        ownBreResults: ownBreResults as unknown as Prisma.InputJsonValue,
      },
    });
    const realEligible = realOffers ?? [];
    const ownEligible = ownBreResults.filter((r) => r.eligible);
    const matched = ownEligible.filter((own) => realEligible.some((real) => lenderNamesMatch(real.name, HL_LENDER_DISPLAY_NAME[own.lender])));
    logger.info(
      {
        event: 'hl_bre_comparison',
        conversationId: ctx.conversationId,
        leadId,
        realChainLenderCount: realEligible.length,
        ownBreLenderCount: ownEligible.length,
        ownBreFoundMoreLenders: ownEligible.length > realEligible.length,
        matchedLenderCount: matched.length,
      },
      'home loan BRE comparison saved',
    );
  } catch (err) {
    // Purely a comparison/calibration run — a failure here must never affect the customer-facing
    // flow, which has already returned its response by the time this runs.
    logger.error({ err, conversationId: ctx.conversationId }, 'hl BRE comparison run failed — continuing without it');
  }
}

/** Pure eligibility math — safe to call repeatedly (e.g. after the customer edits their income
 * from the profile panel) since it has no side effects. Reuses rm/leadId from `previous` when
 * given, so an edit-triggered recompute doesn't reassign the RM or mint a second lead ID.
 *
 * `builderLeadId` is the REAL backend's own lead id (from create_anacity_lead) — only present once
 * a PAN is on file and the lead has actually been created (see ensureLead below), and only
 * actually used once FINFINITY_OFFERS_ENABLED is on (see eligibility.service.ts); the local
 * formula ignores it. Without a PAN (the self-declared-score path), no lead can ever exist, so
 * that path always stays on the local formula regardless of the flag. */
async function computeEligibilityPayload(
  ctx: StepContext,
  previous?: EligibilityResultPayload,
  builderLeadId?: string,
  realRm?: { name: string; phone: string; email: string },
): Promise<EligibilityResultPayload> {
  const a = ctx.answers;
  const segment = a.segment as string;
  const product = a.product as string;
  const income = Number(a.income);
  const emi = Number(a.emi) || 0;
  const pan = a.pan as string | undefined;

  const seedKey = pan || (a.mobile as string) || ctx.conversationId;
  // Placeholder math (see services/eligibility.service.ts) — replaced by the real BRE's numbers
  // once FINFINITY_OFFERS_ENABLED is on; nothing else here depends on which one actually ran.
  let outcome: Awaited<ReturnType<typeof eligibilityService.evaluate>>;
  try {
    outcome = await eligibilityService.evaluate({
      segment: segment as any,
      product,
      income,
      emi,
      seedKey,
      leadId: builderLeadId,
      token: a.finfinityAccessToken as string | undefined,
      productCode: PRODUCT_CODE[product],
      occupancy: a.occupancy as string | undefined,
      isBalanceTransfer: isBT(a),
    });
  } catch (err) {
    // Security-review finding, 2026-10-23: RealEligibilityService throws on a genuine
    // getcustomeroffers failure (missing leadId, no data back, a network error) — left unhandled,
    // that used to bubble all the way up into computeResultPayload's caller as a generic crash, not
    // an honest result. Real failure here means no real offers exist to show, so say that plainly
    // (eligible: false, no offers) instead of either crashing or inventing a fallback number.
    logger.error({ err, conversationId: ctx.conversationId }, 'eligibility/offers check failed — showing no offers instead of a fabricated or hard error');
    outcome = { eligible: false, emi: 0, tenureYears: 0, loanAmountLakh: '0' };
  }

  // Financial eligibility (pure income/FOIR, ignoring the property entirely) is always the best
  // offer's amount. If a property value is known, it's also capped by an assumed LTV % of that
  // value — a placeholder ratio until the real BRE API supplies the actual LTV policy.
  const financialEligibilityLakh = outcome.offers?.[0]?.amountLakh;
  const propertyValue = a.propertyValue as number | undefined;
  let propertyCappedEligibilityLakh: number | undefined;
  if (propertyValue && financialEligibilityLakh !== undefined) {
    const ltv = product === 'Home loan' ? 0.8 : 0.65;
    propertyCappedEligibilityLakh = Number(Math.min(financialEligibilityLakh, ltv * (propertyValue / 100000)).toFixed(1));
  }

  return {
    eligible: outcome.eligible,
    name: a.name as string | undefined,
    product,
    loanType: a.loanType as string,
    segment: segment as any,
    creditScore: a.creditScore as number | undefined,
    propertyType: a.propertyType as string | undefined,
    collateralType: a.collateralType as string | undefined,
    occupancy: a.occupancy as string | undefined,
    propertyValueLakh: propertyValue ? propertyValue / 100000 : undefined,
    financialEligibilityLakh,
    propertyCappedEligibilityLakh,
    offers: outcome.offers,
    // Real one Finfinity actually assigned wins over anything previously computed or placeholder —
    // previous.rm only ever held a placeholder in the first place if no real one had come back yet.
    rm: realRm ?? previous?.rm ?? pickRm(seedKey),
    // Bug fixed 2026-10-31: this ignored the builderLeadId parameter entirely — every call from
    // computeResultPayload (the main eligibility path) already has the REAL Finfinity lead id by
    // this point, but it never reached this field, which instead always fell through to
    // generateLeadId()'s fake "LN<digits><2 letters>" placeholder (since `previous` is undefined on
    // the first computation). The RM-summary email, and anything else reading payload.leadId, showed
    // that fake id forever instead of the real one actually stored in our own backend. Real id now
    // wins whenever one exists; the placeholder only still applies pre-PAN/pre-lead (not eligible to
    // create a real lead yet) or when neither a fresh nor a previous real id is available.
    leadId: builderLeadId ?? previous?.leadId ?? generateLeadId(),
    leadCreated: previous?.leadCreated ?? false,
  };
}

/** Creates the Builder-module lead + local Lead row from whatever PAN/name/score are available.
 * Returns the real backend's own lead id (null on the mock, or on a real backend that hasn't
 * synced yet) so the caller can hand it to a real eligibility/offers call — see computeResultPayload.
 *
 * `syncFullProfile`: also pushes everything updatecustomerv3/updatelead accept (income, EMI,
 * property details, employment type, etc.) — see services/dedupe.service.ts and lead.service.ts.
 * Only set true from the main computeResultPayload path below, where PAN implies contact consent
 * was given, which means email/pincode/segment/income/emi/property were ALL actually asked;
 * createLeadFromResult (the rarer post-result PAN offer) doesn't have that guarantee, so it only
 * creates the lead, same as before this sync existed. A sync failure here is logged, not fatal —
 * worst case the customer still sees whatever eligibility figure the (still-)incomplete lead
 * produces, same as before this existed, rather than the whole result step failing outright. */
/** Every field syncLeadFinancials below actually pushes onto Finfinity (updateCustomer's PAN/
 * email/pincode/segment, updateLead's loanType/income/emi/property details) — compared against
 * Lead.lastSyncedFinancialsJson to decide whether a reused lead's sync can safely be skipped (see
 * ensureLead's own comment on why this exists). Plain key order is fine: this is only ever compared
 * against another call of the exact same function, never hand-written or diffed externally. */
function buildFinancialsSnapshot(ctx: StepContext, info: { pan: string; loanType: string }): string {
  const a = ctx.answers;
  return JSON.stringify({
    pan: info.pan,
    email: a.email,
    pincode: a.pincode,
    segment: a.segment,
    loanType: info.loanType,
    income: Number(a.income) || 0,
    emi: Number(a.emi) || 0,
    propertyIdentified: Boolean(a.propertyValue) || a.propertyGate === 'Yes' || propertyAlreadyIdentified(a),
    propertyType: a.propertyType ?? null,
    occupancy: a.occupancy ?? null,
    collateralType: a.collateralType ?? null,
    propertyValue: a.propertyValue ?? null,
  });
}

async function ensureLead(
  ctx: StepContext,
  info: { pan: string; name?: string; creditScore?: number; product: string; loanType: string },
  opts?: { syncFullProfile?: boolean },
): Promise<{ builderLeadId: string | null; rm?: { name: string; phone: string; email: string }; reused?: boolean }> {
  // Idempotency (security-review finding, 2026-10-23, extended 2026-10-31): ensureLeadOnce (see its
  // own doc comment in lead.service.ts) covers both "this exact conversation already has a lead"
  // (a double-click, a retried request after a network blip) AND "this real customer already has a
  // lead for this product from an earlier conversation" (Start over / a reload / reopening the
  // widget), reusing the existing real lead either way instead of creating a duplicate.
  const result = await ensureLeadOnce({
    conversationId: ctx.conversationId,
    rawPan: info.pan,
    panMasked: maskPan(info.pan),
    name: info.name,
    mobileMasked: ctx.answers.mobile ? maskMobile(ctx.answers.mobile as string) : undefined,
    creditScore: info.creditScore as number,
    product: info.product,
    loanType: info.loanType,
    remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
    token: ctx.answers.finfinityAccessToken as string | undefined,
  });
  const builderLeadId = result.builderLeadId;

  // Bug fixed 2026-11-10: a REUSED lead used to skip this sync unconditionally (2026-10-31 fix,
  // reasoning below) — which also meant a returning customer's CURRENT income/EMI never reached
  // Finfinity at all, so getcustomeroffers kept answering against whatever was on file from the
  // very first time this lead was created (confirmed live: a customer who'd edited income down to
  // ₹30,000 still got eligibility computed against the original ₹4,00,000). Now compares against
  // what was actually last synced (Lead.lastSyncedFinancialsJson) — a genuine change still syncs
  // (and still notifies the RM, correctly, since something real actually changed); only a
  // byte-for-byte-identical revisit skips it, which is what the ORIGINAL 2026-10-31 bug report
  // actually was (five identical "Start over" clicks, not five real updates). updateLead/
  // updateCustomer appear to retrigger Finfinity's own lead notification every time they run, not
  // just on creation, which is why an unconditional sync on every reuse was a real problem worth
  // avoiding in the first place.
  const snapshot = buildFinancialsSnapshot(ctx, info);
  const shouldSync = opts?.syncFullProfile && builderLeadId && (!result.reused || result.lastSyncedFinancialsJson !== snapshot);
  if (shouldSync) {
    await syncLeadFinancials(ctx, builderLeadId, info.pan, info.loanType);
    await markLeadFinancialsSynced(ctx.conversationId, snapshot).catch((err) =>
      logger.error({ err, conversationId: ctx.conversationId }, 'failed to record the synced-financials snapshot — next reuse of this lead will just sync again, which is safe, only slightly redundant'),
    );
  }

  return { builderLeadId, rm: result.rm, reused: result.reused };
}

/** Pushes the customer's current profile + loan financials onto an already-created real lead —
 * used right after creating one, and again whenever an already-shown result gets recomputed after
 * a profile-panel edit (income/EMI/etc.), so a real getcustomeroffers recompute actually reflects
 * the correction instead of the lead's original numbers. The two calls are independent (different
 * endpoints, neither depends on the other's result), so they run concurrently — each is allowed to
 * fail on its own (logged, not thrown) rather than one blocking or aborting the other. */
async function syncLeadFinancials(ctx: StepContext, leadId: string, pan: string, loanType: string): Promise<void> {
  const a = ctx.answers;
  const token = a.finfinityAccessToken as string | undefined;

  // updateCustomer only affects the CUSTOMER record (PAN/email/pincode/segment) — the getoffers
  // call right after this never reads any of that, only the LEAD's own income/EMI (which
  // updateLead sets). So it runs in the background rather than something the customer has to wait
  // on: kicked off here, logged if it fails, never blocking the path to eligibility.
  dedupeService
    .updateCustomer(a.remoteCustomerId as number | undefined, { pan, email: a.email as string | undefined, pincode: a.pincode as string | undefined, segment: a.segment as string | undefined }, token)
    .catch((err) => logger.error({ err, conversationId: ctx.conversationId }, 'updateCustomer sync failed — continuing without it'));

  try {
    await leadService.updateLead(
      leadId,
      {
        loanType,
        income: Number(a.income),
        emi: Number(a.emi) || 0,
        propertyIdentified: Boolean(a.propertyValue) || a.propertyGate === 'Yes' || propertyAlreadyIdentified(a),
        propertyType: a.propertyType as string | undefined,
        occupancy: a.occupancy as string | undefined,
        collateralType: a.collateralType as string | undefined,
        propertyValue: a.propertyValue as number | undefined,
      },
      token,
    );
  } catch (err) {
    logger.error({ err, conversationId: ctx.conversationId }, 'updateLead sync failed — continuing without it');
  }
}

/** Post-result PAN offer only (PAN declined up front, shared only after seeing eligibility) —
 * registers the lead against the numbers already shown. Never recomputes those numbers: showing
 * one set of offers and then silently swapping in different ones after the fact would be a worse
 * experience than just registering interest against what the customer already saw. */
export async function createLeadFromResult(
  ctx: StepContext,
  base: EligibilityResultPayload,
  info: { pan: string; name?: string; creditScore?: number },
): Promise<EligibilityResultPayload> {
  const lead = await ensureLead(ctx, { ...info, product: base.product, loanType: base.loanType });
  // base.rm/base.leadId were only ever placeholders up to now — no lead existed yet to have a real
  // one assigned against. Swap both in now that create_anacity_lead has actually run (2026-10-31
  // fix — leadId used to stay the fake generateLeadId() placeholder forever here too, same bug as
  // computeEligibilityPayload's own leadId field).
  return { ...base, rm: lead.rm ?? base.rm, leadId: lead.builderLeadId ?? base.leadId, leadCreated: true };
}

/** Kicked off as soon as 'profileSummary' is reached (the recap right before 'result') instead of
 * waiting for the customer to click past it — the real work here (create a lead, sync income/EMI,
 * ask for lender offers) is the single slowest thing in the whole conversation, so starting it a
 * step earlier means 'result' often finds it already done, or closer to done, instead of starting
 * from zero. Keyed by conversationId; single-process only — if this ever runs as multiple server
 * instances behind a load balancer, a miss here just falls back to computing fresh in 'result'
 * (correct either way, just loses the head start on a miss). */
const inFlightResults = new Map<string, Promise<EligibilityResultPayload>>();

/** Called once, on first arrival at the 'result' step. When a PAN is already on file, the lead is
 * created FIRST and its real id is handed to computeEligibilityPayload — the real getcustomeroffers
 * API needs an existing lead to ask offers for, so eligibility can no longer be computed before the
 * lead exists the way the local formula always could. Later recomputes (see recomputeEligibility
 * below) must not create a lead again, or they'd try to create a second Lead row. */
export async function computeResultPayload(ctx: StepContext): Promise<EligibilityResultPayload> {
  const a = ctx.answers;
  const pan = a.pan as string | undefined;

  // Home Loan/LAP, non-individual PAN — every intermediate step (loanType/income/property/...)
  // already skipped itself for this case (see isIndividualPan), so none of that data exists to
  // compute anything from. No lead, no eligibility call — just the "not supported yet" message.
  if (isHomeLoanOrLap(a) && !isIndividualPan(pan)) {
    const seedKey = pan || (a.mobile as string) || ctx.conversationId;
    return {
      eligible: false,
      entityNotSupported: true,
      name: a.name as string | undefined,
      product: a.product as string,
      loanType: (a.loanType as string) ?? '',
      segment: a.segment as EligibilityResultPayload['segment'],
      creditScore: a.creditScore as number | undefined,
      rm: pickRm(seedKey),
      leadCreated: false,
    };
  }

  // Security-review finding, 2026-10-23: no age gate existed at all — see MIN_APPLICANT_AGE_YEARS's
  // own comment above. Checked here, before ensureLead below ever creates a real lead, so an
  // underage applicant's PAN never reaches Finfinity as a loan applicant in the first place.
  if (isHomeLoanOrLap(a) && isIndividualPan(pan) && a.dob && calcAge(a.dob as string) < MIN_APPLICANT_AGE_YEARS) {
    const seedKey = pan || (a.mobile as string) || ctx.conversationId;
    return {
      eligible: false,
      underageNotSupported: true,
      name: a.name as string | undefined,
      product: a.product as string,
      loanType: (a.loanType as string) ?? '',
      segment: a.segment as EligibilityResultPayload['segment'],
      creditScore: a.creditScore as number | undefined,
      rm: pickRm(seedKey),
      leadCreated: false,
    };
  }

  let builderLeadId: string | undefined;
  let realRm: { name: string; phone: string; email: string } | undefined;
  if (pan) {
    const lead = await ensureLead(
      ctx,
      {
        pan,
        name: a.name as string | undefined,
        creditScore: a.creditScore as number | undefined,
        product: a.product as string,
        loanType: a.loanType as string,
      },
      { syncFullProfile: true },
    );
    builderLeadId = lead.builderLeadId ?? undefined;
    realRm = lead.rm;
    // By this point in the flow (right before eligibility is computed), income/property/pincode/
    // segment/email are all already collected — fire CIS's webhook here with the full picture,
    // rather than generically at lead-creation time (2026-11-06: fire once all the relevant info for
    // this product is in hand). Skipped for a reused lead, same as the RM-summary-email dedupe.
    if (builderLeadId && !lead.reused) {
      void sendLeadCreatedWebhook({
        leadId: builderLeadId,
        name: a.name as string | undefined,
        mobile: a.mobile as string | undefined,
        email: a.email as string | undefined,
        pan,
        product: a.product as string,
        loanType: a.loanType as string,
        segment: a.segment as string | undefined,
        pincode: a.pincode as string | undefined,
        city: a.pincodeArea as string | undefined,
        monthlyIncome: Number(a.income) || undefined,
      });
    }
  }

  const base = await computeEligibilityPayload(ctx, undefined, builderLeadId, realRm);
  if (pan) base.leadCreated = true;

  await prisma.conversation.update({ where: { id: ctx.conversationId }, data: { status: 'completed' } });

  // Never awaited — see runOwnHlBreComparison's own doc comment. Must not delay or ever throw into
  // this response, which has already been computed above.
  void runOwnHlBreComparison(ctx, builderLeadId, base.offers);

  return base;
}

/** Re-runs just the eligibility math after a post-result profile edit (e.g. income corrected from
 * the side panel) — never touches lead creation or conversation status again. Looks the lead back
 * up (rather than creating a new one) so a real getcustomeroffers recompute asks the same lead for
 * updated offers — pushes whatever just changed onto that lead first (see syncLeadFinancials below)
 * so the recompute actually reflects the edit instead of the lead's original numbers. */
export async function recomputeEligibility(ctx: StepContext, previous: EligibilityResultPayload): Promise<EligibilityResultPayload> {
  const pan = ctx.answers.pan as string | undefined;
  let builderLeadId: string | undefined;
  if (pan) {
    const lead = await prisma.lead.findUnique({ where: { conversationId: ctx.conversationId } });
    builderLeadId = lead?.builderLeadId ?? undefined;
    // Push whatever just changed (income/EMI/pincode/segment/etc.) onto the real lead BEFORE
    // asking for updated offers — otherwise a real getcustomeroffers recompute would still be
    // answering against the lead's ORIGINAL numbers, silently ignoring the edit just made.
    if (builderLeadId) {
      const loanType = ctx.answers.loanType as string;
      await syncLeadFinancials(ctx, builderLeadId, pan, loanType);
      // Recorded so a LATER fresh conversation reusing this same lead (see ensureLead's own
      // snapshot comparison) correctly recognizes this edit already happened, instead of treating
      // it as unsynced and re-pushing (and re-notifying the RM for) the exact same numbers again.
      await markLeadFinancialsSynced(ctx.conversationId, buildFinancialsSnapshot(ctx, { pan, loanType })).catch((err) =>
        logger.error({ err, conversationId: ctx.conversationId }, 'failed to record the synced-financials snapshot after a profile-panel edit — harmless, just slightly redundant next time'),
      );
    }
  }
  return computeEligibilityPayload(ctx, previous, builderLeadId);
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'still being reviewed',
  synced: 'approved and synced with the lender',
  failed: 'flagged for a manual follow-up',
};

export interface ApplicationOption {
  builderLeadId: string;
  label: string; // e.g. "Home loan — Fresh purchase (Lead ID: 74695)" — status isn't in here yet
}

/** Every application on file for this mobile number (not PAN or a Customer record, so it finds
 * one even for someone who shared PAN only via the post-result offer on a previous visit) — a
 * customer can genuinely have more than one (e.g. a home loan check one visit, a LAP check
 * another), so this lists all of them rather than silently picking just the most recent. Doesn't
 * fetch status yet — that's a separate real API call per lead, deferred until the customer has
 * actually picked which one they want (see applicationSelector/fetchApplicationStatus below). */
async function listApplications(mobileHash: string): Promise<ApplicationOption[]> {
  const leads = await prisma.lead.findMany({
    where: { conversation: { mobileHash }, builderLeadId: { not: null } },
    orderBy: { createdAt: 'desc' },
    include: { conversation: { include: { answers: { where: { stepId: { in: ['product', 'loanType'] } } } } } },
  });
  return leads.map((lead) => {
    const product = lead.conversation.answers.find((a) => a.stepId === 'product')?.value as string | undefined;
    const loanType = lead.conversation.answers.find((a) => a.stepId === 'loanType')?.value as string | undefined;
    const productLabel = product ? `${product}${loanType ? ` — ${loanType}` : ''}` : 'Loan application';
    return { builderLeadId: lead.builderLeadId as string, label: `${productLabel} (Lead ID: ${lead.builderLeadId})` };
  });
}

/** A status-lookup failure is shown inline rather than thrown, so one bad call never blanks out
 * the whole result when the customer only asked about this one application. */
async function describeApplicationStatus(app: ApplicationOption, token: string | undefined): Promise<string> {
  try {
    const status = await statusService.getStatus(app.builderLeadId, token);
    const statusLabel = STATUS_LABEL[status.status] ?? status.status;
    return `${app.label} — <strong>${statusLabel}</strong>`;
  } catch (err) {
    logger.error({ err, builderLeadId: app.builderLeadId }, 'status lookup failed for one lead — showing the rest anyway');
    return `${app.label} — status temporarily unavailable`;
  }
}

export const homeLoanFlow: FlowDefinition = {
  id: 'home_loan_v1',
  steps: [
    {
      id: 'intent',
      type: 'choice',
      progressLabel: 'Getting started',
      // Pre-seeded (along with mobile/finfinityAccessToken) when a "check eligibility again"
      // click resumes a still-fresh remembered identity — see identity.service.ts.
      isApplicable: (ctx) => !ctx.answers.intent,
      botMessage: () => "Hi, I'm your loan assistant. Would you like to check your eligibility, or check on an existing application?",
      input: () => ({ type: 'choice', options: [CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'intent', [CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION], value, 'Would you like to check your eligibility, or an existing application?'),
    },
    // Every eligibility check needs a verified mobile number — the real backend's own APIs
    // (dedupe/PAN/bureau/lead/offers) only accept calls carrying the access token that a
    // successful OTP verify returns, so there's no working "skip the OTP, give me an estimate"
    // path anymore. Consent to share these details is implicit in providing them; still logged
    // to ConsentAudit below for the same compliance trail the old explicit yes/no step gave.
    {
      id: 'mobile',
      type: 'mobile',
      progressLabel: 'Getting started',
      // !ctx.answers.mobile: a remembered identity (see identity.service.ts) pre-seeds this along
      // with finfinityAccessToken, letting a "check eligibility again" resume skip straight past
      // typing the number in again — has no effect on a normal fresh conversation, where mobile
      // is never pre-set.
      isApplicable: (ctx) => (ctx.answers.intent === CHECK_EXISTING_APPLICATION || isEligibilityIntent(ctx.answers)) && !ctx.answers.mobile,
      botMessage: (ctx) =>
        isEligibilityIntent(ctx.answers)
          ? "Great — let's check what you're eligible for. What's your mobile number?"
          : "What's the mobile number on the application?",
      restatement: () => "What's your mobile number?",
      hint: () => "We'll verify this number as we go.",
      input: () => ({ type: 'mobile' }),
      validate: (value) => {
        const v = (value || '').trim();
        if (!/^[6-9]\d{9}$/.test(v)) return { ok: false, error: 'Enter a valid 10-digit mobile number.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        const mobile = parsed as string;
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { mobileHash: hmacLookup(mobile), mobileMasked: maskMobile(mobile), panConsent: true },
        });
        await prisma.consentAudit.create({
          data: { conversationId: ctx.conversationId, decision: true, ipAddress: ctx.meta.ip, userAgent: ctx.meta.userAgent },
        });
      },
    },
    // ---------- OTP #1: dedupe/identity OTP — verified BEFORE we know found vs not-found, since
    // the real backend hands us a usable token only once this succeeds, and even the very first
    // lookup (checking if this mobile is already a customer) needs that token. Same two steps for
    // everyone; the actual found/not-found branch is decided by dedupeCheck right after this. ----------
    {
      id: 'triggerOtpDedupe',
      type: 'apiFetch',
      progressLabel: 'Getting started',
      isApplicable: (ctx) => needsIdentityOtp(ctx.answers) && !ctx.answers.finfinityAccessToken,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        await smsService.sendOtp(ctx.conversationId, ctx.answers.mobile as string);
      },
    },
    {
      id: 'otpDedupe',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => needsIdentityOtp(ctx.answers) && !ctx.answers.finfinityAccessToken,
      botMessage: (ctx) => `We've sent a 6-digit OTP to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it confirms it's you.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        let result: { ok: boolean; remoteCustomerId?: number; accessToken?: string; refreshToken?: string };
        try {
          result = await smsService.verifyOtp(ctx.conversationId, parsed as string);
        } catch (err) {
          // See verifyOtpOrThrow's own comment above — same fix, same reasoning.
          if (err instanceof Error && err.message === 'otp_locked') {
            throw new Error('Too many incorrect attempts. Please request a new OTP.');
          }
          throw new Error('Something went wrong verifying your OTP. Please try again.');
        }
        if (!result.ok) throw new Error('Incorrect OTP. Please try again.');
        // This IS the login step — there's no separate credential to configure. The access token
        // this returns is what every authenticated call for the rest of the conversation uses (see
        // ctx.answers.finfinityAccessToken below and finfinityClient.ts's doc comment). Also the
        // not-found branch's only opportunity to learn the real backend's customer id before
        // dedupeCheck runs (validateotpv2 creates the customer as a side effect); a found
        // customer's own id (from searchcustomer) overwrites this right after, in dedupeCheck below.
        const identity = await establishIdentitySession(
          ctx,
          ctx.answers.mobile as string,
          result.accessToken,
          result.refreshToken,
          result.remoteCustomerId,
        );
        return {
          ...(result.remoteCustomerId !== undefined ? { remoteCustomerId: result.remoteCustomerId } : {}),
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
          ...identity,
        };
      },
    },
    // ---------- "check an existing application" branch (identity is already verified above) ----------
    {
      id: 'fetchApplications',
      type: 'apiFetch',
      progressLabel: 'Checking your applications',
      isApplicable: (ctx) => ctx.answers.intent === CHECK_EXISTING_APPLICATION,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const applications = await listApplications(hmacLookup(ctx.answers.mobile as string));
        // Only one on file — nothing to actually choose between, so skip the selector entirely.
        if (applications.length === 1) return { applications, selectedLeadId: applications[0].builderLeadId };
        return { applications };
      },
    },
    {
      id: 'applicationSelector',
      type: 'choice',
      progressLabel: 'Checking your applications',
      isApplicable: (ctx) =>
        ctx.answers.intent === CHECK_EXISTING_APPLICATION &&
        Array.isArray(ctx.answers.applications) &&
        (ctx.answers.applications as ApplicationOption[]).length > 1 &&
        !ctx.answers.selectedLeadId,
      botMessage: () => 'You have more than one application on file — which one would you like to check?',
      input: (ctx) => ({ type: 'choice', options: (ctx.answers.applications as ApplicationOption[]).map((a) => a.label), layout: 'column' }),
      validate: (value, ctx) => {
        const options = (ctx.answers.applications as ApplicationOption[]).map((a) => a.label);
        return validateChoice(ctx, 'applicationSelector', options, value, 'Which application would you like to check?');
      },
      onAnswer: async (parsed, ctx) => {
        const match = (ctx.answers.applications as ApplicationOption[]).find((a) => a.label === parsed);
        return { selectedLeadId: match?.builderLeadId };
      },
    },
    {
      id: 'fetchApplicationStatus',
      type: 'apiFetch',
      progressLabel: 'Checking your applications',
      isApplicable: (ctx) => ctx.answers.intent === CHECK_EXISTING_APPLICATION,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const applications = (ctx.answers.applications as ApplicationOption[]) ?? [];
        if (applications.length === 0) {
          return { statusMessage: "We couldn't find an existing application for this mobile number. Start a new check any time to see your eligibility." };
        }
        const token = ctx.answers.finfinityAccessToken as string | undefined;
        const selected = applications.find((a) => a.builderLeadId === ctx.answers.selectedLeadId);
        if (!selected) {
          // Shouldn't happen — selectedLeadId always comes from one of `applications` above — but
          // fail safe by listing everything rather than showing nothing at all.
          const lines = await Promise.all(applications.map((a) => describeApplicationStatus(a, token)));
          return { statusMessage: `You have ${lines.length} applications on file:<br>${lines.map((l) => `• ${l}`).join('<br>')}` };
        }
        const line = await describeApplicationStatus(selected, token);
        return { statusMessage: `Your application — ${line}.` };
      },
    },
    {
      id: 'dedupeCheck',
      type: 'apiFetch',
      progressLabel: 'Getting started',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = await dedupeService.check(ctx.answers.mobile as string, ctx.answers.finfinityAccessToken as string | undefined);
        if (!match) return { dedupeFound: false };

        // Only the mock produces a local customerId (a real local-Customer-table row) — the real
        // service only ever gives us remoteCustomerId, since a real customer's record lives in
        // Finfinity's own system, not ours. Linking to a non-existent local row would crash on a
        // foreign-key violation.
        if (match.customerId) {
          await prisma.conversation.update({ where: { id: ctx.conversationId }, data: { customerId: match.customerId } });
        }

        // searchcustomer's real response now includes whatever bureau score is already on file
        // (see dedupe.service.ts) — falling back to our own cache only covers the mock and any
        // real customer searchcustomer doesn't have a score for yet. Found here means the
        // bureau-consent OTP gets skipped entirely below; not found just means the customer
        // verifies it fresh, same as ever.
        let creditScore = match.creditScore;
        if (!creditScore) {
          const cached = await customerService.findCachedBureauScore(hmacLookup(ctx.answers.mobile as string));
          if (cached) creditScore = cached.creditScore;
        }

        return {
          dedupeFound: true,
          customerId: match.customerId,
          remoteCustomerId: match.remoteCustomerId,
          name: match.name,
          pan: match.pan,
          dob: match.dob,
          email: match.email,
          pincode: match.pincode,
          segment: match.segment,
          gender: match.gender,
          creditScore,
          // Captured for later — not yet acted on anywhere in the flow (still deciding how
          // needsBureauRefresh/needsBureauConsent should change behavior; see DedupeMatch's doc
          // comment in dedupe.service.ts).
          bureauSource: match.bureauSource,
          bureauFetchDate: match.bureauFetchDate,
          needsBureauRefresh: match.needsBureauRefresh,
          needsBureauConsent: match.needsBureauConsent,
        };
      },
    },

    // ---------- found branch ----------
    {
      id: 'profileFound',
      type: 'message',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true,
      botMessage: (ctx) => renderFoundProfileSummary(ctx),
      input: () => ({ type: 'none' }),
    },
    // ---------- not-found branch ----------
    // No separate PAN-specific consent gate — providing the mobile number up front already
    // covers it (see the 'mobile' step's onAnswer) — straight to PAN.
    {
      id: 'pan',
      type: 'pan',
      progressLabel: 'About you',
      // !ctx.answers.fullName (NOT !ctx.answers.pan — ctx.answers.pan is set to the raw typed
      // value the INSTANT this step is answered, before panFetch's lookup has even run, so gating
      // on it would skip panFetch for every brand-new customer too, not just a pre-seeded one.
      // fullName only ever becomes truthy once a real lookup — fresh or pre-seeded from
      // profile.service.ts for a DIFFERENT product in the last 10 minutes — has actually completed.
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !ctx.answers.fullName,
      botMessage: () => 'Thanks! Please share your PAN so we can look up your details.',
      hint: () => 'Lets us fetch your name and pull your credit bureau report.',
      input: () => ({ type: 'pan' }),
      validate: (value) => {
        const v = (value || '').trim().toUpperCase();
        if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return { ok: false, error: 'Enter a valid PAN, e.g. ABCDE1234F.' };
        return { ok: true, parsed: v };
      },
    },
    {
      id: 'panFetch',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !ctx.answers.fullName,
      botMessage: (ctx) => (ctx.answers.fullName ? `We found you as <strong>${escapeHtml(ctx.answers.name as string)}</strong>.` : null),
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const identity = await panService.lookup(ctx.answers.pan as string, ctx.answers.finfinityAccessToken as string | undefined);
        const prefilledName = ctx.answers.prefilledName as string | undefined;
        const mismatch = Boolean(prefilledName && identity.name && !namesLooselyMatch(prefilledName, identity.name));
        // Only ever runs for dedupeFound === false (see isApplicable above), which is exactly the
        // case with no other way to avoid re-asking PAN for a different product within 10 minutes.
        void rememberProfile(ctx.answers.mobile as string, { pan: ctx.answers.pan as string, fullName: identity.name, dob: identity.dob, gender: identity.gender });
        return { name: identity.nameMasked, fullName: identity.name, dob: identity.dob, gender: identity.gender, nameMismatchPending: mismatch };
      },
    },
    // ---------- SDK name-prefill mismatch guard (not-found branch only) — only ever fires when a
    // partner's launch token actually included a name AND the real PAN record's name doesn't loosely
    // match it (see namesLooselyMatch's own doc comment). Reuses the exact same duplicateField/
    // panDuplicateChoice combo the PAN-collision retry below already keys off, so "Enter a different
    // PAN" here walks straight into panRetry/panRetryFetch with no new step logic needed. ----------
    {
      id: 'panNameMismatchChoice',
      type: 'choice',
      progressLabel: 'About you',
      isApplicable: (ctx) => HOME_LOAN_NAME_MISMATCH_CHECK_ENABLED && ctx.answers.dedupeFound === false && Boolean(ctx.answers.nameMismatchPending),
      botMessage: (ctx) =>
        `The name on this PAN doesn't quite match <strong>${escapeHtml(ctx.answers.prefilledName as string)}</strong> — would you like to continue with this PAN, or enter a different one?`,
      input: () => ({ type: 'choice', options: ['Continue with this PAN', 'Enter a different PAN'], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'panNameMismatchChoice', ['Continue with this PAN', 'Enter a different PAN'], value, 'Would you like to continue with this PAN, or enter a different one?'),
      onAnswer: async (parsed) => {
        if (parsed === 'Enter a different PAN') {
          return { nameMismatchPending: false, duplicateField: 'PAN', panDuplicateChoice: 'Enter a different PAN' };
        }
        return { nameMismatchPending: false };
      },
    },
    // ---------- PAN-collision guard (not-found branch only) ----------
    // Catches a PAN that already belongs to a DIFFERENT existing customer before it's ever written
    // onto this brand-new record — updateCustomer/create_anacity_lead would otherwise silently
    // overwrite that other customer's data the moment the lead is created.
    {
      id: 'panDuplicateCheck',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !ctx.answers.panDuplicateChecked,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = await dedupeService.matchBy('pan', ctx.answers.pan as string, ctx.answers.finfinityAccessToken as string | undefined);
        if (!match) {
          // No collision — safe to let a different product skip this exact check too within the
          // remembered-profile window, rather than re-running a real API call for the same PAN.
          void rememberProfile(ctx.answers.mobile as string, { panDuplicateChecked: true });
          return { panDuplicateChecked: true };
        }
        return { panDuplicateChecked: true, duplicatePending: true, duplicateField: 'PAN', duplicateMatch: match };
      },
    },
    {
      id: 'panDuplicateChoice',
      type: 'choice',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && Boolean(ctx.answers.duplicatePending) && ctx.answers.duplicateField === 'PAN',
      // Security-review finding, 2026-10-23: this used to show the matched account's masked mobile
      // (8 of its 10 digits visible) right here — meaning anyone could type in a stranger's real PAN
      // and both (a) learn they're an existing customer and (b) see almost their entire real phone
      // number, all without ever proving they own either. The verify-OTP step right after this still
      // sends the real OTP to that number (the genuine re-verification mechanism) — it's just never
      // shown to the person who typed the PAN in.
      botMessage: () => `That PAN is already linked to an existing account. Would you like to verify with that account's number instead, or enter a different PAN?`,
      input: () => ({ type: 'choice', options: ['Verify with that number', 'Enter a different PAN'], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'panDuplicateChoice', ['Verify with that number', 'Enter a different PAN'], value, 'Would you like to verify with that number, or enter a different PAN?'),
    },
    {
      id: 'triggerOtpPanDuplicateVerify',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'PAN' && ctx.answers.panDuplicateChoice === 'Verify with that number',
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        await enforceDuplicateVerifyRateLimit(match.mobileFull);
        await smsService.sendOtp(ctx.conversationId, match.mobileFull);
        // Set now (not only on verify success) so a resend-OTP click — which only ever has
        // ctx.answers.mobile to work with — sends to the right number too.
        return { mobile: match.mobileFull };
      },
    },
    {
      id: 'otpPanDuplicateVerify',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'PAN' && ctx.answers.panDuplicateChoice === 'Verify with that number',
      // Security-review finding, 2026-10-23: ctx.answers.mobile here is the OTHER customer's real
      // number (set by triggerOtpPanDuplicateVerify right above) — showing its masked form still
      // revealed 8 of its 10 real digits to whoever typed in this PAN, the same leak as
      // panDuplicateChoice's own message just one step later. The OTP still goes to that real
      // number; this just stops echoing it back to the person who hasn't proven they own it.
      botMessage: () => `We've sent a 6-digit OTP to that account's registered mobile number — entering it verifies it's your account.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        const result = await verifyOtpOrThrow(ctx.conversationId, parsed as string);
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { mobileHash: hmacLookup(match.mobileFull), mobileMasked: maskMobile(match.mobileFull) },
        });
        // Adopts the matched account wholesale — this customer IS that existing customer, just
        // reached via the wrong number. dedupeFound: true means every step from here on (email/
        // pincode/segment/bureau) treats them exactly like the normal found branch would.
        const identity = await establishIdentitySession(ctx, match.mobileFull, result.accessToken, result.refreshToken, match.remoteCustomerId);
        return {
          dedupeFound: true,
          duplicatePending: false,
          adoptedViaDuplicate: true,
          duplicateMatch: undefined,
          remoteCustomerId: match.remoteCustomerId,
          name: match.name,
          pan: match.pan,
          dob: match.dob,
          email: match.email,
          pincode: match.pincode,
          segment: match.segment,
          creditScore: match.creditScore,
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
          ...identity,
        };
      },
    },
    {
      id: 'panRetry',
      type: 'pan',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'PAN' && ctx.answers.panDuplicateChoice === 'Enter a different PAN',
      botMessage: () => 'No problem — please enter a different PAN.',
      hint: () => 'Lets us fetch your name and pull your credit bureau report.',
      input: () => ({ type: 'pan' }),
      validate: (value) => {
        const v = (value || '').trim().toUpperCase();
        if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return { ok: false, error: 'Enter a valid PAN, e.g. ABCDE1234F.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed) => ({ pan: parsed, duplicatePending: false }),
    },
    {
      id: 'panRetryFetch',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'PAN' && ctx.answers.panDuplicateChoice === 'Enter a different PAN',
      botMessage: (ctx) => (ctx.answers.fullName ? `We found you as <strong>${escapeHtml(ctx.answers.name as string)}</strong>.` : null),
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const identity = await panService.lookup(ctx.answers.pan as string, ctx.answers.finfinityAccessToken as string | undefined);
        // Same name-mismatch re-check as panFetch — a retry PAN can mismatch the partner's prefilled
        // name too, and panNameMismatchChoice's own isApplicable doesn't care which fetch step set
        // the flag, so re-setting it here routes straight back into the same choice step.
        const prefilledName = ctx.answers.prefilledName as string | undefined;
        const mismatch = Boolean(prefilledName && identity.name && !namesLooselyMatch(prefilledName, identity.name));
        return { name: identity.nameMasked, fullName: identity.name, dob: identity.dob, nameMismatchPending: mismatch };
      },
    },
    {
      id: 'panRetryDuplicateCheck',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'PAN' && ctx.answers.panDuplicateChoice === 'Enter a different PAN',
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = await dedupeService.matchBy('pan', ctx.answers.pan as string, ctx.answers.finfinityAccessToken as string | undefined);
        if (!match) return { duplicateField: undefined, panDuplicateChoice: undefined, duplicateMatch: undefined };
        // Still linked to another account on the retry too — a bounded stop rather than an
        // infinite loop. The 'restart' action swaps the widget's default "Try again" (which would
        // just repeat this same, always-losing check) for a button that actually leads somewhere.
        throw new UserFacingError(
          "That PAN also looks like it's linked to another existing account. Please restart the chat with the correct mobile number, or contact our support team for help.",
          'restart',
        );
      },
    },
    // ---------- shared: fill in whatever's still missing (either branch) ----------
    {
      id: 'email',
      type: 'text',
      progressLabel: 'About you',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && !ctx.answers.email,
      botMessage: (ctx) => (ctx.answers.dedupeFound === true ? "We don't have an email on file for you — what's a good one to use?" : "What's your email address?"),
      input: () => ({ type: 'text', placeholder: 'you@example.com' }),
      validate: (value) => {
        const v = (value || '').trim();
        if (!EMAIL_PATTERN.test(v)) return { ok: false, error: 'Enter a valid email address.' };
        const [local, domain] = v.split('@');
        if (!domain || !EMAIL_DOMAIN_PATTERN.test(domain.toLowerCase())) {
          return { ok: false, error: "That email domain doesn't look right — check it and try again." };
        }
        const suggestion = suggestedEmailDomain(domain.toLowerCase());
        if (suggestion) return { ok: false, error: `Did you mean ${local}@${suggestion}?` };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        if (ctx.answers.customerId) await customerService.updateMissingField(ctx.answers.customerId as string, 'email', parsed as string);
      },
    },
    // ---------- email-collision guard (not-found branch only) — same idea as the PAN one above ----------
    {
      id: 'emailDuplicateCheck',
      type: 'apiFetch',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !ctx.answers.emailDuplicateChecked,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = await dedupeService.matchBy('email', ctx.answers.email as string, ctx.answers.finfinityAccessToken as string | undefined);
        if (!match) return { emailDuplicateChecked: true };
        return { emailDuplicateChecked: true, duplicatePending: true, duplicateField: 'email', duplicateMatch: match };
      },
    },
    {
      id: 'emailDuplicateChoice',
      type: 'choice',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && Boolean(ctx.answers.duplicatePending) && ctx.answers.duplicateField === 'email',
      // See panDuplicateChoice's own comment above — same leak, same fix: don't show the matched
      // account's mobile number to whoever typed in this email.
      botMessage: () => `That email is already linked to an existing account. Would you like to verify with that account's number instead, or enter a different email?`,
      input: () => ({ type: 'choice', options: ['Verify with that number', 'Enter a different email'], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'emailDuplicateChoice', ['Verify with that number', 'Enter a different email'], value, 'Would you like to verify with that number, or enter a different email?'),
    },
    {
      id: 'triggerOtpEmailDuplicateVerify',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'email' && ctx.answers.emailDuplicateChoice === 'Verify with that number',
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        await enforceDuplicateVerifyRateLimit(match.mobileFull);
        await smsService.sendOtp(ctx.conversationId, match.mobileFull);
        return { mobile: match.mobileFull };
      },
    },
    {
      id: 'otpEmailDuplicateVerify',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'email' && ctx.answers.emailDuplicateChoice === 'Verify with that number',
      // See otpPanDuplicateVerify's own comment above — same leak, same fix.
      botMessage: () => `We've sent a 6-digit OTP to that account's registered mobile number — entering it verifies it's your account.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        const result = await verifyOtpOrThrow(ctx.conversationId, parsed as string);
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { mobileHash: hmacLookup(match.mobileFull), mobileMasked: maskMobile(match.mobileFull) },
        });
        const identity = await establishIdentitySession(ctx, match.mobileFull, result.accessToken, result.refreshToken, match.remoteCustomerId);
        return {
          dedupeFound: true,
          duplicatePending: false,
          adoptedViaDuplicate: true,
          duplicateMatch: undefined,
          remoteCustomerId: match.remoteCustomerId,
          name: match.name,
          pan: match.pan,
          dob: match.dob,
          email: match.email,
          pincode: match.pincode,
          segment: match.segment,
          creditScore: match.creditScore,
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
          ...identity,
        };
      },
    },
    {
      id: 'emailRetry',
      type: 'text',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'email' && ctx.answers.emailDuplicateChoice === 'Enter a different email',
      botMessage: () => 'No problem — please enter a different email address.',
      input: () => ({ type: 'text', placeholder: 'you@example.com' }),
      validate: (value) => {
        const v = (value || '').trim();
        if (!EMAIL_PATTERN.test(v)) return { ok: false, error: 'Enter a valid email address.' };
        const [local, domain] = v.split('@');
        if (!domain || !EMAIL_DOMAIN_PATTERN.test(domain.toLowerCase())) {
          return { ok: false, error: "That email domain doesn't look right — check it and try again." };
        }
        const suggestion = suggestedEmailDomain(domain.toLowerCase());
        if (suggestion) return { ok: false, error: `Did you mean ${local}@${suggestion}?` };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed) => ({ email: parsed, duplicatePending: false }),
    },
    {
      id: 'emailRetryDuplicateCheck',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.duplicateField === 'email' && ctx.answers.emailDuplicateChoice === 'Enter a different email',
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const match = await dedupeService.matchBy('email', ctx.answers.email as string, ctx.answers.finfinityAccessToken as string | undefined);
        if (!match) return { duplicateField: undefined, emailDuplicateChoice: undefined, duplicateMatch: undefined };
        throw new UserFacingError(
          "That email also looks like it's linked to another existing account. Please restart the chat, or contact our support team for help.",
          'restart',
        );
      },
    },
    {
      id: 'pincode',
      type: 'text',
      progressLabel: 'About you',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && !ctx.answers.pincode,
      botMessage: (ctx) => (ctx.answers.dedupeFound === true ? "And we're missing your current residence pincode — what is it?" : "What's your current residence pincode?"),
      hint: () => 'For checking lenders in your area.',
      input: () => ({ type: 'text', placeholder: 'e.g. 400001', maxLength: 6 }),
      validate: (value) => {
        const v = (value || '').trim();
        if (!/^[1-9]\d{5}$/.test(v)) return { ok: false, error: 'Enter a valid 6-digit pincode.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        if (ctx.answers.customerId) await customerService.updateMissingField(ctx.answers.customerId as string, 'pincode', parsed as string);
        const area = await pincodeService.lookupArea(parsed as string);
        void rememberProfile(ctx.answers.mobile as string, { pincode: parsed as string });
        return area ? { pincodeArea: area } : undefined;
      },
    },
    {
      id: 'pincodeConfirm',
      type: 'message',
      progressLabel: 'About you',
      isApplicable: (ctx) => Boolean(ctx.answers.pincodeArea),
      botMessage: (ctx) => `Got it — ${ctx.answers.pincode} is ${escapeHtml(ctx.answers.pincodeArea as string)}.`,
      input: () => ({ type: 'none' }),
    },
    {
      id: 'segment',
      type: 'choice',
      progressLabel: 'About you',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && !ctx.answers.segment,
      botMessage: (ctx) =>
        ctx.answers.dedupeFound === true
          ? 'One more thing — which of these best describes you: salaried, a business owner, or a self-employed professional?'
          : 'Which of these best describes you — are you salaried, a business owner, or a self-employed professional?',
      hint: () => 'Used to apply the right eligibility criteria for your profile.',
      input: () => ({ type: 'choice', options: [...SEGMENTS], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'segment', [...SEGMENTS], value, 'Are you salaried, a business owner, or a self-employed professional?', SEGMENT_HINTS),
      onAnswer: async (parsed, ctx) => {
        if (ctx.answers.customerId) await customerService.updateMissingField(ctx.answers.customerId as string, 'segment', parsed as string);
      },
    },
    // A customer adopted via the PAN/email duplicate-match flow above never passes through
    // 'profileFound' (it sits much earlier in this array, at a position forward-walk has already
    // moved past by the time dedupeFound flips to true here) — without this, they'd go straight
    // from a successful verify into another OTP request with no "here's what we found" in between.
    {
      id: 'duplicateProfileFound',
      type: 'message',
      progressLabel: 'About you',
      isApplicable: (ctx) => Boolean(ctx.answers.adoptedViaDuplicate),
      botMessage: (ctx) => renderFoundProfileSummary(ctx),
      input: () => ({ type: 'none' }),
    },
    // ---------- OTP #2: bureau/PAN consent OTP — a second, separate verification specifically
    // for the credit-bureau pull, right before it happens. (In the real system this second
    // check isn't a plain OTP box for every customer: the primary bureau asks a knowledge-based
    // question instead, and only the fallback bureau sends a second OTP — see bureau.service.ts's
    // realBureauApi and its doc comment. This generic OTP step is the mock/interim stand-in for
    // whichever of those two the flow ends up needing; the CIBIL-question UI is separate follow-up
    // work.) Only shown for a found customer when their score isn't already on file — otherwise
    // there's nothing new to pull, so no reason to ask for a second OTP. ----------
    {
      id: 'triggerOtpBureauFound',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore && !realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        await smsService.sendOtp(ctx.conversationId, ctx.answers.mobile as string);
      },
    },
    {
      id: 'otpBureauFound',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore && !realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        let result: { ok: boolean; accessToken?: string; refreshToken?: string };
        try {
          result = await smsService.verifyOtp(ctx.conversationId, parsed as string);
        } catch (err) {
          // See verifyOtpOrThrow's own comment above — same fix, same reasoning.
          if (err instanceof Error && err.message === 'otp_locked') {
            throw new Error('Too many incorrect attempts. Please request a new OTP.');
          }
          throw new Error('Something went wrong verifying your OTP. Please try again.');
        }
        if (!result.ok) throw new Error('Incorrect OTP. Please try again.');
        // Placeholder: the real bureau consent step returns its own fresh token pair (see
        // bureau.service.ts's realBureauApi) — this generic OTP verify is standing in for that
        // until the CIBIL-question/Experian-OTP UI exists, but still carries a token forward the
        // same way so lead creation/offers right after this always have the most recent one.
        return {
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
        };
      },
    },
    // ---------- Real interactive bureau check (2026-11-06) — generatebureau + validatebureau,
    // replacing the placeholder generic-OTP-then-mock-score path above when realBureauFlowEnabled.
    // Confirmed live by Ritendra: generatebureau ALSO sends an OTP for the CIBIL path (not just
    // Experian, despite bureau_api_payloads.txt only documenting a "question" for CIBIL) — the
    // customer only ever types an OTP in either case. The CIBIL questionKey/answerKey/
    // ChallengeConfigGUID are never shown to or asked from the customer; they're just carried
    // through automatically from generateBureau()'s response into validateBureauCibil(). Error
    // handling deliberately minimal for now (e.g. a wrong OTP just says "try again", no distinct
    // "CIBIL rejected your answer" messaging) — explicit instruction, 2026-11-06, to refine once
    // the rest of the team is back online tomorrow. ----------
    {
      id: 'triggerBureauRealFound',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore && realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const resp = await realBureauApi.generateBureau({
          pan: ctx.answers.pan as string,
          phoneNumber: ctx.answers.mobile as string,
          officialEmail: ctx.answers.email as string,
          pincode: ctx.answers.pincode as string,
          applicantTypeKey: mapSegmentToHlEmploymentType(ctx.answers.segment as string | undefined),
          token: ctx.answers.finfinityAccessToken as string,
        });
        return resp.bureau_type === 'CIBIL'
          ? {
              bureauRealType: 'CIBIL' as const,
              bureauRealCustomerId: resp.customer_id,
              bureauRealOtpSessionId: resp.otp_session_id,
              bureauRealQuestionKey: resp.questionKey,
              bureauRealAnswerKey: resp.answerKey,
              bureauRealChallengeGuid: resp.ChallengeConfigGUID,
            }
          : { bureauRealType: 'EXPERIAN' as const, bureauRealCustomerId: resp.customer_id, bureauRealOtpSessionId: resp.otp_session_id };
      },
    },
    {
      id: 'otpBureauRealFound',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore && realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        const a = ctx.answers;
        const token = a.finfinityAccessToken as string;
        let pull: BureauPull;
        try {
          pull =
            a.bureauRealType === 'CIBIL'
              ? await realBureauApi.validateBureauCibil({
                  customerId: a.bureauRealCustomerId as number,
                  otpSessionId: a.bureauRealOtpSessionId as string,
                  phoneNumber: a.mobile as string,
                  questionKey: a.bureauRealQuestionKey as string,
                  answerKey: a.bureauRealAnswerKey as string,
                  challengeConfigGuid: a.bureauRealChallengeGuid as string,
                  otp: parsed as string,
                  token,
                })
              : await realBureauApi.validateBureauExperian({
                  customerId: a.bureauRealCustomerId as number,
                  otpSessionId: a.bureauRealOtpSessionId as string,
                  phoneNumber: a.mobile as string,
                  otp: parsed as string,
                  token,
                });
        } catch (err) {
          logger.error({ err, event: 'bureau_real_validate_failed' }, 'validatebureau failed');
          throw new Error('Incorrect OTP. Please try again.');
        }
        return {
          creditScore: pull.creditScore,
          bureauSource: pull.source,
          ...(pull.accessToken ? { finfinityAccessToken: pull.accessToken } : {}),
          ...(pull.refreshToken ? { finfinityRefreshToken: pull.refreshToken } : {}),
        };
      },
    },
    {
      id: 'bureauFetchFound',
      type: 'apiFetch',
      progressLabel: 'Checking credit profile',
      // Gated on its OWN bureauScoreShown flag, not creditScore — the real path above now sets
      // creditScore BEFORE this step is reached (unlike the mock path, which only sets it here), so
      // gating on creditScore itself would skip this step (and its caching + message) for the real
      // path entirely.
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.bureauScoreShown && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => `Your CIBIL score is <strong>${ctx.answers.creditScore}</strong>.`,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        let creditScore = ctx.answers.creditScore as number | undefined;
        let bureauSource = ctx.answers.bureauSource as 'bureau' | 'experian' | undefined;
        if (creditScore === undefined) {
          // Mock path only — the real interactive flow above already set these.
          const pull = await bureauService.pull(ctx.answers.pan as string, {
            dob: ctx.answers.dob as string | undefined,
            pincode: ctx.answers.pincode as string | undefined,
            email: ctx.answers.email as string | undefined,
          });
          creditScore = pull.creditScore;
          bureauSource = pull.source;
        }
        if (ctx.answers.customerId) await customerService.updateMissingField(ctx.answers.customerId as string, 'creditScore', creditScore);
        // Real dedupe-found customers never get a local customerId (see dedupe.service.ts), so
        // the line above is a no-op for them — cache by mobileHash instead, so dedupeCheck can
        // find it next time and skip this whole OTP for a customer we've already scored.
        await customerService.cacheBureauScore(hmacLookup(ctx.answers.mobile as string), maskMobile(ctx.answers.mobile as string), creditScore, bureauSource as 'bureau' | 'experian');
        void rememberProfile(ctx.answers.mobile as string, { creditScore, bureauSource: bureauSource as 'bureau' | 'experian' });
        return { creditScore, bureauSource, bureauScoreShown: true };
      },
    },
    // ---------- not-found branch: same OTP #2 (bureau/PAN consent), then reveal the credit score ----------
    {
      id: 'triggerOtpBureauNotFound',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        await smsService.sendOtp(ctx.conversationId, ctx.answers.mobile as string);
      },
    },
    {
      id: 'otpBureauNotFound',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && !realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        let result: { ok: boolean; accessToken?: string; refreshToken?: string };
        try {
          result = await smsService.verifyOtp(ctx.conversationId, parsed as string);
        } catch (err) {
          // See verifyOtpOrThrow's own comment above — same fix, same reasoning.
          if (err instanceof Error && err.message === 'otp_locked') {
            throw new Error('Too many incorrect attempts. Please request a new OTP.');
          }
          throw new Error('Something went wrong verifying your OTP. Please try again.');
        }
        if (!result.ok) throw new Error('Incorrect OTP. Please try again.');
        // Placeholder — see the equivalent comment on otpBureauFound above.
        return {
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
        };
      },
    },
    // ---------- Real interactive bureau check, not-found branch — see the found-branch's own
    // comment above (triggerBureauRealFound) for the full explanation. ----------
    {
      id: 'triggerBureauRealNotFound',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const resp = await realBureauApi.generateBureau({
          pan: ctx.answers.pan as string,
          phoneNumber: ctx.answers.mobile as string,
          officialEmail: ctx.answers.email as string,
          pincode: ctx.answers.pincode as string,
          applicantTypeKey: mapSegmentToHlEmploymentType(ctx.answers.segment as string | undefined),
          token: ctx.answers.finfinityAccessToken as string,
        });
        return resp.bureau_type === 'CIBIL'
          ? {
              bureauRealType: 'CIBIL' as const,
              bureauRealCustomerId: resp.customer_id,
              bureauRealOtpSessionId: resp.otp_session_id,
              bureauRealQuestionKey: resp.questionKey,
              bureauRealAnswerKey: resp.answerKey,
              bureauRealChallengeGuid: resp.ChallengeConfigGUID,
            }
          : { bureauRealType: 'EXPERIAN' as const, bureauRealCustomerId: resp.customer_id, bureauRealOtpSessionId: resp.otp_session_id };
      },
    },
    {
      id: 'otpBureauRealNotFound',
      type: 'otp',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && realBureauFlowEnabled && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      input: () => ({ type: 'otp', length: 6 }),
      validate: (value) => {
        const v = (value || '').replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) return { ok: false, error: 'Enter all 6 digits.' };
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        const a = ctx.answers;
        const token = a.finfinityAccessToken as string;
        let pull: BureauPull;
        try {
          pull =
            a.bureauRealType === 'CIBIL'
              ? await realBureauApi.validateBureauCibil({
                  customerId: a.bureauRealCustomerId as number,
                  otpSessionId: a.bureauRealOtpSessionId as string,
                  phoneNumber: a.mobile as string,
                  questionKey: a.bureauRealQuestionKey as string,
                  answerKey: a.bureauRealAnswerKey as string,
                  challengeConfigGuid: a.bureauRealChallengeGuid as string,
                  otp: parsed as string,
                  token,
                })
              : await realBureauApi.validateBureauExperian({
                  customerId: a.bureauRealCustomerId as number,
                  otpSessionId: a.bureauRealOtpSessionId as string,
                  phoneNumber: a.mobile as string,
                  otp: parsed as string,
                  token,
                });
        } catch (err) {
          logger.error({ err, event: 'bureau_real_validate_failed' }, 'validatebureau failed');
          throw new Error('Incorrect OTP. Please try again.');
        }
        void rememberProfile(a.mobile as string, { creditScore: pull.creditScore, bureauSource: pull.source });
        return {
          creditScore: pull.creditScore,
          bureauSource: pull.source,
          ...(pull.accessToken ? { finfinityAccessToken: pull.accessToken } : {}),
          ...(pull.refreshToken ? { finfinityRefreshToken: pull.refreshToken } : {}),
        };
      },
    },
    {
      id: 'bureauFetchNotFound',
      type: 'apiFetch',
      progressLabel: 'Checking credit profile',
      // Deliberately NOT gated on isIndividualPan — this step also promotes the masked name to the
      // real one (see onAnswer), which still has to happen for a non-individual PAN even though the
      // bureau pull itself is skipped for them. Only the API call inside onAnswer is conditional.
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
      botMessage: (ctx) => {
        const a = ctx.answers;
        const displayName = (a.fullName as string | undefined) ?? (a.name as string);
        const lines = [`<strong>Name:</strong> ${escapeHtml(displayName)}`];
        if (a.dob) {
          lines.push(
            isIndividualPan(a.pan as string | undefined)
              ? `<strong>DOB:</strong> ${formatDob(a.dob as string)} (age ${calcAge(a.dob as string)})`
              : `<strong>Date of incorporation:</strong> ${formatDob(a.dob as string)}`,
          );
        }
        if (a.pincode) lines.push(`<strong>Pincode:</strong> ${a.pincode}`);
        if (a.creditScore) lines.push(`<strong>CIBIL score:</strong> ${a.creditScore}`);
        return `Here's what we have:<br>${lines.join('<br>')}`;
      },
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        // "No Bureau API to be hit where 4th letter in PAN is NOT P" (2026-10-17 instruction) — the
        // OTP consent steps right before this are already skipped for a non-individual PAN (see
        // triggerOtpBureauNotFound/otpBureauNotFound), so there's no consent to act on here either;
        // skip the real pull entirely rather than calling it anyway with no OTP ever having run.
        // The real interactive flow above already set creditScore for this conversation before this
        // step is ever reached — only the mock path (triggerOtpBureauNotFound/otpBureauNotFound)
        // leaves it unset here, needing this fallback call.
        const isIndividual = isIndividualPan(ctx.answers.pan as string | undefined);
        const pull =
          isIndividual && ctx.answers.creditScore === undefined
            ? await bureauService.pull(ctx.answers.pan as string, {
                dob: ctx.answers.dob as string | undefined,
                pincode: ctx.answers.pincode as string | undefined,
                email: ctx.answers.email as string | undefined,
              })
            : undefined;
        if (pull) void rememberProfile(ctx.answers.mobile as string, { creditScore: pull.creditScore, bureauSource: pull.source });
        // Replaces the masked name panFetch showed with the real one, now that both OTPs
        // (identity, then bureau consent) are cleared — same bar the dedupe-found branch clears
        // with just its one OTP before ever storing the real name. Updating the actual answers.name
        // value (not just a display-time swap in botMessage above) means everything that reads it
        // downstream — the profile sidebar, the result card — picks up the real name too, not just
        // this one chat bubble. Still happens even when the bureau pull itself was skipped.
        return {
          ...(pull ? { creditScore: pull.creditScore, bureauSource: pull.source } : {}),
          ...(ctx.answers.fullName ? { name: ctx.answers.fullName } : {}),
        };
      },
    },
    {
      id: 'createCustomer',
      type: 'apiFetch',
      progressLabel: 'Checking credit profile',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
      botMessage: () => null,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const a = ctx.answers;
        const { id } = await customerService.create({
          mobileHash: hmacLookup(a.mobile as string),
          mobileMasked: maskMobile(a.mobile as string),
          pan: a.pan as string,
          name: (a.fullName as string) ?? (a.name as string),
          dob: a.dob as string,
          email: a.email as string,
          pincode: a.pincode as string,
          segment: a.segment as string,
          creditScore: a.creditScore as number,
          bureauSource: (a.bureauSource as 'bureau' | 'experian') ?? 'bureau',
        });
        await prisma.conversation.update({ where: { id: ctx.conversationId }, data: { customerId: id } });
        return { customerId: id };
      },
    },

    // ---------- shared loan questions ----------
    {
      id: 'product',
      type: 'choice',
      progressLabel: 'Choosing a product',
      // !ctx.answers.product: an SDK launch token (see externalLaunch.service.ts) can pre-seed this
      // when Finfinity's own app already knows what the customer picked before opening the widget —
      // without this guard, applicablePath/firstStepId would still land here and ask again.
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && !ctx.answers.product,
      botMessage: () => 'What are you looking for?',
      // Business Loan doesn't work for a salaried customer at all (2026-10-17 instruction) — hidden
      // from the options entirely rather than offered and then rejected deeper into its own flow.
      input: (ctx) => ({ type: 'choice', options: productOptionsFor(ctx), layout: 'column' }),
      // Personal loan/Gold loan/Business loan branch into their own short flows right after this
      // step (see flows/index.ts, which splices flows/personalLoan.ts etc. in here) — everything
      // below in this file (loanType onward) only ever runs for Home loan/Loan Against Property,
      // same as before this step gained the three extra options.
      validate: (value, ctx) => validateChoice(ctx, 'product', productOptionsFor(ctx), value, `Which of these is it: ${productOptionsFor(ctx).join(', ')}?`),
    },
    {
      id: 'loanType',
      type: 'choice',
      progressLabel: 'Choosing a product',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined) && !ctx.answers.loanType,
      botMessage: (ctx) => {
        const options = LOAN_TYPES[ctx.answers.product as string] ?? [];
        return `Got it — <strong>${ctx.answers.product}</strong>. What type of loan is this: ${options.join(' or ')}?`;
      },
      restatement: (ctx) => {
        const options = LOAN_TYPES[ctx.answers.product as string] ?? [];
        return `What type of loan is this: ${options.join(' or ')}?`;
      },
      input: (ctx) => ({ type: 'choice', options: LOAN_TYPES[ctx.answers.product as string] ?? [], layout: 'column' }),
      validate: (value, ctx) => {
        const options = LOAN_TYPES[ctx.answers.product as string] ?? [];
        return validateChoice(ctx, 'loanType', options, value, `Which of these is it: ${options.join(', ')}?`);
      },
    },
    {
      id: 'income',
      type: 'number',
      progressLabel: 'Financial details',
      // !ctx.answers.income: lets income already given for a DIFFERENT product (Home Loan/LAP
      // share this exact question — see isHomeLoanOrLap) in the last 10 minutes skip straight past
      // this (see profile.service.ts) — without this check, a pre-seeded income would be silently
      // ignored and asked again, same class of bug as pan/panFetch's own !ctx.answers.fullName gate.
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined) && !ctx.answers.income,
      botMessage: () => "What's your monthly income?",
      // Segment is already known by this step (asked earlier) — no need to hedge with "or... if
      // self-employed" when we can just say the one that actually applies (2026-10-31 instruction).
      hint: (ctx) => (ctx.answers.segment === 'Salaried' ? 'Net take-home.' : 'Average monthly income.'),
      input: () => ({ type: 'number', placeholder: 'e.g. 85000, or 1.2 lakh' }),
      validate: (value) => {
        const v = parseAmount(value);
        if (!v || v < MIN_SANE_INCOME) {
          return { ok: false, error: `Enter your actual monthly income — e.g. 85000. It should be at least ₹${MIN_SANE_INCOME.toLocaleString('en-IN')}.` };
        }
        if (v > MAX_SANE_MONTHLY_AMOUNT) {
          return { ok: false, error: `That doesn't look right — enter your actual monthly income (up to ₹${MAX_SANE_MONTHLY_AMOUNT.toLocaleString('en-IN')}).` };
        }
        return { ok: true, parsed: v };
      },
      onAnswer: async (parsed, ctx) => {
        void rememberProfile(ctx.answers.mobile as string, { income: parsed as number });
      },
    },
    {
      id: 'emi',
      type: 'number',
      progressLabel: 'Financial details',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: () => 'Do you currently have any other loan EMIs?',
      hint: (ctx) => (isBT(ctx.answers) ? "Don't include the loan you're transferring." : 'Say "no" if you don\'t have any.'),
      input: () => ({ type: 'number', placeholder: "e.g. 12000, or 'no'" }),
      validate: (value, ctx) => {
        const v = parseAmount(value);
        if (v === null || v < 0) return { ok: false, error: "Enter the amount, or say 'no' if you don't have any." };
        const income = Number(ctx.answers.income);
        if (income && v > income) return { ok: false, error: 'Your EMI cannot be more than your income.' };
        return { ok: true, parsed: v };
      },
    },
    {
      id: 'propertyGate',
      type: 'choice',
      progressLabel: 'Property details',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined) && !propertyAlreadyIdentified(ctx.answers),
      botMessage: () => "Have you already identified the property you're planning to buy, or not yet?",
      input: () => ({ type: 'choice', options: ['Yes', 'Not yet'], layout: 'row' }),
      validate: (value, ctx) => {
        const result = validateChoice(ctx, 'propertyGate', ['Yes', 'Not yet'], value, 'Have you identified the property yet — yes or not yet?');
        if (result.ok) result.parsed = result.parsed === 'Yes' ? 'Yes' : 'No';
        return result;
      },
    },
    {
      id: 'propertyType',
      type: 'choice',
      progressLabel: 'Property details',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined) && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
      botMessage: (ctx) => {
        const options = PROPERTY_TYPES[ctx.answers.product as string] ?? [];
        return `What type of property is it — ${options.join(', ')}?`;
      },
      hint: () => 'For underwriting context only.',
      input: (ctx) => ({ type: 'choice', options: PROPERTY_TYPES[ctx.answers.product as string] ?? [], layout: 'column' }),
      validate: (value, ctx) => {
        const options = PROPERTY_TYPES[ctx.answers.product as string] ?? [];
        return validateChoice(ctx, 'propertyType', options, value, `Which of these is it: ${options.join(', ')}?`);
      },
    },
    {
      id: 'propertyValue',
      type: 'number',
      progressLabel: 'Property details',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined) && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
      botMessage: () => "What's the property worth (its market/agreement value)?",
      hint: () => `At least ₹${(MIN_PROPERTY_VALUE / 100000).toFixed(0)} lakh.`,
      input: () => ({ type: 'number', placeholder: 'e.g. 75 lakh' }),
      validate: (value) => {
        const v = parseAmount(value);
        if (!v || v < MIN_PROPERTY_VALUE) {
          return { ok: false, error: `Enter the property's value — it should be at least ₹${(MIN_PROPERTY_VALUE / 100000).toFixed(0)} lakh.` };
        }
        if (v > MAX_SANE_PROPERTY_VALUE) {
          return { ok: false, error: `That doesn't look right — enter the property's real value (up to ₹${(MAX_SANE_PROPERTY_VALUE / 10000000).toFixed(0)} crore).` };
        }
        return { ok: true, parsed: v };
      },
    },
    {
      id: 'occupancy',
      type: 'choice',
      progressLabel: 'Property details',
      isApplicable: (ctx) =>
        isEligibilityIntent(ctx.answers) && ctx.answers.product === 'Loan Against Property' && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
      botMessage: () => "And what's the occupancy status of the property — is it self-occupied, rented, or vacant?",
      input: () => ({ type: 'choice', options: ['Self-occupied', 'Rented', 'Vacant'], layout: 'row' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'occupancy', ['Self-occupied', 'Rented', 'Vacant'], value, 'Is it self-occupied, rented, or vacant?'),
    },
    {
      id: 'collateralType',
      type: 'choice',
      progressLabel: 'Property details',
      isApplicable: (ctx) =>
        isEligibilityIntent(ctx.answers) && ctx.answers.product === 'Loan Against Property' && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
      botMessage: (ctx) => {
        const options = COLLATERAL_TYPES[ctx.answers.propertyType as string] ?? [];
        return `And what type of ${String(ctx.answers.propertyType).toLowerCase()} collateral is it — ${options.join(', ')}?`;
      },
      hint: () => 'For underwriting context only.',
      input: (ctx) => ({ type: 'choice', options: COLLATERAL_TYPES[ctx.answers.propertyType as string] ?? [], layout: 'column' }),
      validate: (value, ctx) => {
        const options = COLLATERAL_TYPES[ctx.answers.propertyType as string] ?? [];
        return validateChoice(ctx, 'collateralType', options, value, `Which of these is it: ${options.join(', ')}?`);
      },
    },
    {
      id: 'profileSummary',
      type: 'message',
      progressLabel: 'Your eligibility',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && isHomeLoanOrLap(ctx.answers) && isIndividualPan(ctx.answers.pan as string | undefined),
      botMessage: (ctx) => buildProfileSummary(ctx),
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        // Start the real lead-creation + offers work now, in the background — not awaited, so
        // this step still renders immediately. 'result' picks up whatever this produces.
        if (!inFlightResults.has(ctx.conversationId)) {
          const promise = computeResultPayload(ctx);
          promise.catch(() => {}); // avoid an unhandled-rejection warning if the customer never reaches 'result' to await it
          inFlightResults.set(ctx.conversationId, promise);
          setTimeout(() => inFlightResults.delete(ctx.conversationId), 2 * 60 * 1000).unref();
        }
      },
    },
    {
      id: 'result',
      type: 'result',
      progressLabel: 'Your eligibility',
      // Also serves CHECK_EXISTING_APPLICATION's statusMessage (unconditionally applicable there,
      // same as before) — only gated to Home loan/LAP for the eligibility-check path, since
      // Personal/Gold/Business loan and Loan Against Securities have their own terminal 'result'
      // step (plResult/etc.) and never reach this one.
      isApplicable: (ctx) => !isEligibilityIntent(ctx.answers) || isHomeLoanOrLap(ctx.answers),
      botMessage: (ctx) => {
        if (!isEligibilityIntent(ctx.answers)) return (ctx.answers.statusMessage as string) ?? 'Checking your application status…';
        const payload = ctx.answers.resultPayload as EligibilityResultPayload | undefined;
        if (payload?.entityNotSupported) return "We don't have a journey for entities yet — this product is currently only available for individual applicants.";
        if (payload?.underageNotSupported) return "We're unable to proceed — applicants must be at least 18 years old for this product.";
        // By 'result', both branches have cleared identity OTP + bureau-consent OTP — the real
        // first name (firstName() prefers fullName over the masked name) is fair to show either way.
        if (ctx.answers.name || ctx.answers.fullName) return `Here's your loan eligibility, ${firstName(ctx)}.`;
        return "Here's your loan eligibility.";
      },
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        // statusMessage is already set by fetchApplicationStatus above for the non-eligibility
        // (existing-application) intent — nothing further to compute here for that case.
        if (!isEligibilityIntent(ctx.answers)) return undefined;
        // profileSummary already started this in the background — usually already done (or
        // closer to done) by the time we get here. Falls back to computing fresh on a miss (a
        // resumed session, a multi-instance deploy, or the 2-minute cache window having lapsed).
        const pending = inFlightResults.get(ctx.conversationId);
        inFlightResults.delete(ctx.conversationId);
        const resultPayload = pending ? await pending : await computeResultPayload(ctx);
        return { resultPayload };
      },
    },
  ],
};
