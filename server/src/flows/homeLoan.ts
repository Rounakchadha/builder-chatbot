import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, COLLATERAL_TYPES, LOAN_TYPES, PROPERTY_TYPES, SEGMENTS, type EligibilityResultPayload } from '@loan-chatbot/shared';
import type { Answers, FlowDefinition, StepContext } from '../flow-engine/types';
import { encryptPii, hmacLookup, maskMobile, maskPan } from '../lib/crypto';
import { escapeHtml } from '../lib/escapeHtml';
import { logger } from '../lib/logger';
import type { SemanticHint } from '../lib/matchChoice';
import { parseAmount } from '../lib/parseAmount';
import { validateChoice } from '../lib/validateChoice';
import { UserFacingError } from '../lib/userFacingError';
import { prisma } from '../lib/prisma';
import { bureauService } from '../services/bureau.service';
import { customerService } from '../services/customer.service';
import { dedupeService, type DuplicateMatch } from '../services/dedupe.service';
import { eligibilityService } from '../services/eligibility.service';
import { leadService, PRODUCT_CODE } from '../services/lead.service';
import { panService } from '../services/pan.service';
import { pincodeService } from '../services/pincode.service';
import { smsService, enforceDuplicateVerifyRateLimit } from '../services/sms.service';
import { rememberIdentity } from '../services/identity.service';
import { statusService } from '../services/status.service';
import { generateLeadId, pickRm } from './rm';

function isEligibilityIntent(answers: Answers): boolean {
  return answers.intent === CHECK_ELIGIBILITY;
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
    throw new Error('Too many incorrect attempts. Please request a new OTP.');
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
  return { identityToken };
}

function isBT(answers: Answers): boolean {
  return String(answers.loanType || '').includes('Balance transfer');
}

/** Property is already identified for balance transfers and LAP-against-owned-property; still needs asking for fresh purchases. */
function propertyAlreadyIdentified(answers: Answers): boolean {
  return isBT(answers) || answers.loanType === 'Loan against property (LAP)';
}

function calcAge(dobIso: string): number {
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
 * existing customer by the time this renders, just reached via a different path. */
function renderFoundProfileSummary(ctx: StepContext): string {
  const a = ctx.answers;
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>Name:</strong> ${escapeHtml(a.name as string)}`);
  if (a.pan) lines.push(`<strong>PAN:</strong> ${maskPan(a.pan as string)}`);
  if (a.dob) lines.push(`<strong>DOB:</strong> ${formatDob(a.dob as string)} (age ${calcAge(a.dob as string)})`);
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
  if (a.pan) lines.push(`<strong>PAN:</strong> ${a.pan}`);
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

  return `Here's what I've got so far:<br>${lines.join('<br>')}<br><br>Let me check your eligibility across lenders now.`;
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
async function computeEligibilityPayload(ctx: StepContext, previous?: EligibilityResultPayload, builderLeadId?: string): Promise<EligibilityResultPayload> {
  const a = ctx.answers;
  const segment = a.segment as string;
  const product = a.product as string;
  const income = Number(a.income);
  const emi = Number(a.emi) || 0;
  const pan = a.pan as string | undefined;

  const seedKey = pan || (a.mobile as string) || ctx.conversationId;
  // Placeholder math (see services/eligibility.service.ts) — replaced by the real BRE's numbers
  // once FINFINITY_OFFERS_ENABLED is on; nothing else here depends on which one actually ran.
  const outcome = await eligibilityService.evaluate({
    segment: segment as any,
    product,
    income,
    emi,
    seedKey,
    leadId: builderLeadId,
    token: a.finfinityAccessToken as string | undefined,
    productCode: PRODUCT_CODE[product],
  });

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
    rm: previous?.rm ?? pickRm(seedKey),
    leadId: previous?.leadId ?? generateLeadId(),
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
async function ensureLead(
  ctx: StepContext,
  info: { pan: string; name?: string; creditScore?: number; product: string; loanType: string },
  opts?: { syncFullProfile?: boolean },
): Promise<{ builderLeadId: string | null }> {
  const result = await leadService.createLead({
    conversationId: ctx.conversationId,
    panMasked: maskPan(info.pan),
    name: info.name,
    mobileMasked: ctx.answers.mobile ? maskMobile(ctx.answers.mobile as string) : undefined,
    creditScore: info.creditScore as number,
    product: info.product,
    loanType: info.loanType,
    remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
    token: ctx.answers.finfinityAccessToken as string | undefined,
  });
  await prisma.lead.create({
    data: {
      conversationId: ctx.conversationId,
      panEncrypted: encryptPii(info.pan),
      panMasked: maskPan(info.pan),
      nameEncrypted: info.name ? encryptPii(info.name) : null,
      creditScore: info.creditScore ?? null,
      builderLeadId: result.builderLeadId,
      builderSyncStatus: result.status,
    },
  });

  if (opts?.syncFullProfile && result.builderLeadId) {
    await syncLeadFinancials(ctx, result.builderLeadId, info.pan, info.loanType);
  }

  return { builderLeadId: result.builderLeadId };
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

  const [customerResult, leadResult] = await Promise.allSettled([
    dedupeService.updateCustomer(
      a.remoteCustomerId as number | undefined,
      { pan, email: a.email as string | undefined, pincode: a.pincode as string | undefined, segment: a.segment as string | undefined },
      token,
    ),
    leadService.updateLead(
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
    ),
  ]);
  if (customerResult.status === 'rejected') {
    logger.error({ err: customerResult.reason, conversationId: ctx.conversationId }, 'updateCustomer sync failed — continuing without it');
  }
  if (leadResult.status === 'rejected') {
    logger.error({ err: leadResult.reason, conversationId: ctx.conversationId }, 'updateLead sync failed — continuing without it');
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
  await ensureLead(ctx, { ...info, product: base.product, loanType: base.loanType });
  return { ...base, leadCreated: true };
}

/** Called once, on first arrival at the 'result' step. When a PAN is already on file, the lead is
 * created FIRST and its real id is handed to computeEligibilityPayload — the real getcustomeroffers
 * API needs an existing lead to ask offers for, so eligibility can no longer be computed before the
 * lead exists the way the local formula always could. Later recomputes (see recomputeEligibility
 * below) must not create a lead again, or they'd try to create a second Lead row. */
export async function computeResultPayload(ctx: StepContext): Promise<EligibilityResultPayload> {
  const a = ctx.answers;
  const pan = a.pan as string | undefined;

  let builderLeadId: string | undefined;
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
  }

  const base = await computeEligibilityPayload(ctx, undefined, builderLeadId);
  if (pan) base.leadCreated = true;

  await prisma.conversation.update({ where: { id: ctx.conversationId }, data: { status: 'completed' } });

  return base;
}

/** Re-runs just the eligibility math after a post-result profile edit (e.g. income corrected from
 * the side panel) — never touches lead creation or conversation status again. Looks the lead back
 * up (rather than creating a new one) so a real getcustomeroffers recompute asks the same lead for
 * updated offers — note this asks the real backend for the SAME lead's offers again; it does not
 * push the edited answer (e.g. the corrected income) to the backend first, so until that's also
 * wired in, a real recompute may still reflect the lead's original numbers. */
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
      await syncLeadFinancials(ctx, builderLeadId, pan, ctx.answers.loanType as string);
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
      hint: () => 'Confirms the number is yours.',
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
          throw new Error('Too many incorrect attempts. Please request a new OTP.');
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

        // searchcustomer's real response never includes a credit score at all — the only way we'd
        // already know one for a real customer is if we cached it ourselves on a PREVIOUS
        // eligibility check (see bureauFetchFound). Found here means the bureau-consent OTP gets
        // skipped entirely below; not found just means the customer verifies it fresh, same as ever.
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
          creditScore,
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
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
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
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
      botMessage: (ctx) => (ctx.answers.fullName ? `We found you as <strong>${escapeHtml(ctx.answers.name as string)}</strong>.` : null),
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const identity = await panService.lookup(ctx.answers.pan as string, ctx.answers.finfinityAccessToken as string | undefined);
        return { name: identity.nameMasked, fullName: identity.name, dob: identity.dob };
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
        if (!match) return { panDuplicateChecked: true };
        return { panDuplicateChecked: true, duplicatePending: true, duplicateField: 'PAN', duplicateMatch: match };
      },
    },
    {
      id: 'panDuplicateChoice',
      type: 'choice',
      progressLabel: 'About you',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false && Boolean(ctx.answers.duplicatePending) && ctx.answers.duplicateField === 'PAN',
      botMessage: (ctx) => {
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        return `That PAN is already linked to an existing account — mobile number ending in ${match.mobileMasked}. Would you like to verify with that number instead, or enter a different PAN?`;
      },
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
      botMessage: (ctx) => `We've sent a 6-digit OTP to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it verifies it's your account.`,
      hint: () => 'Confirms the number is yours.',
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
        return { name: identity.nameMasked, fullName: identity.name, dob: identity.dob };
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
      botMessage: (ctx) => {
        const match = ctx.answers.duplicateMatch as DuplicateMatch;
        return `That email is already linked to an existing account — mobile number ending in ${match.mobileMasked}. Would you like to verify with that number instead, or enter a different email?`;
      },
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
      botMessage: (ctx) => `We've sent a 6-digit OTP to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it verifies it's your account.`,
      hint: () => 'Confirms the number is yours.',
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
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore,
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
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore,
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      hint: () => 'Confirms the number is yours and gives bureau consent.',
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
          throw new Error('Too many incorrect attempts. Please request a new OTP.');
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
    {
      id: 'bureauFetchFound',
      type: 'apiFetch',
      progressLabel: 'Checking credit profile',
      isApplicable: (ctx) => ctx.answers.dedupeFound === true && !ctx.answers.creditScore,
      botMessage: (ctx) => `Your CIBIL score is <strong>${ctx.answers.creditScore}</strong>.`,
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const pull = await bureauService.pull(ctx.answers.pan as string, {
          dob: ctx.answers.dob as string | undefined,
          pincode: ctx.answers.pincode as string | undefined,
          email: ctx.answers.email as string | undefined,
        });
        if (ctx.answers.customerId) await customerService.updateMissingField(ctx.answers.customerId as string, 'creditScore', pull.creditScore);
        // Real dedupe-found customers never get a local customerId (see dedupe.service.ts), so
        // the line above is a no-op for them — cache by mobileHash instead, so dedupeCheck can
        // find it next time and skip this whole OTP for a customer we've already scored.
        await customerService.cacheBureauScore(
          hmacLookup(ctx.answers.mobile as string),
          maskMobile(ctx.answers.mobile as string),
          pull.creditScore,
          pull.source,
        );
        return { creditScore: pull.creditScore, bureauSource: pull.source };
      },
    },
    // ---------- not-found branch: same OTP #2 (bureau/PAN consent), then reveal the credit score ----------
    {
      id: 'triggerOtpBureauNotFound',
      type: 'apiFetch',
      progressLabel: 'Verifying identity',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
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
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
      botMessage: (ctx) => `We've sent a 6-digit code to +91 ${maskMobile(ctx.answers.mobile as string)} — entering it gives us your consent to pull your credit bureau report.`,
      hint: () => 'Confirms the number is yours and gives bureau consent.',
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
          throw new Error('Too many incorrect attempts. Please request a new OTP.');
        }
        if (!result.ok) throw new Error('Incorrect OTP. Please try again.');
        // Placeholder — see the equivalent comment on otpBureauFound above.
        return {
          ...(result.accessToken ? { finfinityAccessToken: result.accessToken } : {}),
          ...(result.refreshToken ? { finfinityRefreshToken: result.refreshToken } : {}),
        };
      },
    },
    {
      id: 'bureauFetchNotFound',
      type: 'apiFetch',
      progressLabel: 'Checking credit profile',
      isApplicable: (ctx) => ctx.answers.dedupeFound === false,
      botMessage: (ctx) => {
        const a = ctx.answers;
        const lines = [`<strong>Name:</strong> ${escapeHtml(a.name as string)}`];
        if (a.dob) lines.push(`<strong>DOB:</strong> ${formatDob(a.dob as string)} (age ${calcAge(a.dob as string)})`);
        if (a.pincode) lines.push(`<strong>Pincode:</strong> ${a.pincode}`);
        lines.push(`<strong>CIBIL score:</strong> ${a.creditScore}`);
        return `Here's what we have:<br>${lines.join('<br>')}`;
      },
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        const pull = await bureauService.pull(ctx.answers.pan as string, {
          dob: ctx.answers.dob as string | undefined,
          pincode: ctx.answers.pincode as string | undefined,
          email: ctx.answers.email as string | undefined,
        });
        return { creditScore: pull.creditScore, bureauSource: pull.source };
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
      botMessage: () => 'What are you looking for — a home loan, or a loan against property?',
      hint: () => 'Both are available to you.',
      input: () => ({ type: 'choice', options: ['Home loan', 'Loan against property'], layout: 'column' }),
      validate: (value, ctx) =>
        validateChoice(ctx, 'product', ['Home loan', 'Loan against property'], value, 'Is this for a home loan, or a loan against property?'),
    },
    {
      id: 'loanType',
      type: 'choice',
      progressLabel: 'Choosing a product',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
      botMessage: () => "What's your monthly income?",
      hint: () => 'Net take-home, or average monthly income if self-employed.',
      input: () => ({ type: 'number', placeholder: 'e.g. 85000, or 1.2 lakh' }),
      validate: (value) => {
        const v = parseAmount(value);
        if (!v || v < MIN_SANE_INCOME) {
          return { ok: false, error: `Enter your actual monthly income — e.g. 85000. It should be at least ₹${MIN_SANE_INCOME.toLocaleString('en-IN')}.` };
        }
        return { ok: true, parsed: v };
      },
    },
    {
      id: 'emi',
      type: 'number',
      progressLabel: 'Financial details',
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && !propertyAlreadyIdentified(ctx.answers),
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers) && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
      botMessage: () => "What's the property worth (its market/agreement value)?",
      hint: () => `At least ₹${(MIN_PROPERTY_VALUE / 100000).toFixed(0)} lakh.`,
      input: () => ({ type: 'number', placeholder: 'e.g. 75 lakh' }),
      validate: (value) => {
        const v = parseAmount(value);
        if (!v || v < MIN_PROPERTY_VALUE) {
          return { ok: false, error: `Enter the property's value — it should be at least ₹${(MIN_PROPERTY_VALUE / 100000).toFixed(0)} lakh.` };
        }
        return { ok: true, parsed: v };
      },
    },
    {
      id: 'occupancy',
      type: 'choice',
      progressLabel: 'Property details',
      isApplicable: (ctx) =>
        isEligibilityIntent(ctx.answers) && ctx.answers.product === 'Loan against property' && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
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
        isEligibilityIntent(ctx.answers) && ctx.answers.product === 'Loan against property' && (propertyAlreadyIdentified(ctx.answers) || ctx.answers.propertyGate === 'Yes'),
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
      isApplicable: (ctx) => isEligibilityIntent(ctx.answers),
      botMessage: (ctx) => buildProfileSummary(ctx),
      input: () => ({ type: 'none' }),
    },
    {
      id: 'result',
      type: 'result',
      progressLabel: 'Your eligibility',
      botMessage: (ctx) => {
        if (!isEligibilityIntent(ctx.answers)) return (ctx.answers.statusMessage as string) ?? 'Checking your application status…';
        // Only use the real first name once identity has actually been OTP-confirmed (the
        // dedupe-found branch) — the not-found branch never verifies OTP, so it only ever gets
        // the masked name, same as panFetch's message.
        if (ctx.answers.dedupeFound === true) return `Here's your loan eligibility, ${firstName(ctx)}.`;
        return ctx.answers.name ? `Here's your loan eligibility for ${escapeHtml(ctx.answers.name as string)}.` : "Here's your loan eligibility.";
      },
      input: () => ({ type: 'none' }),
      onAnswer: async (_parsed, ctx) => {
        // statusMessage is already set by fetchApplicationStatus above for the non-eligibility
        // (existing-application) intent — nothing further to compute here for that case.
        if (!isEligibilityIntent(ctx.answers)) return undefined;
        const resultPayload = await computeResultPayload(ctx);
        return { resultPayload };
      },
    },
  ],
};
