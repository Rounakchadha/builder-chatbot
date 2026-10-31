import type { FastifyInstance } from 'fastify';
import { ChatMessageRequest, CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse, type EligibilityResultPayload } from '@builder-chatbot/shared';
import { applicablePath, getStep, nextStepId, renderStep } from '../flow-engine/engine';
import type { StepContext } from '../flow-engine/types';
import { mainFlow } from '../flows';
import { recomputeEligibility, createLeadFromResult } from '../flows/homeLoan';
import { buildGoldLoanRmDetails } from '../flows/goldLoan';
import { buildLasRmDetails } from '../flows/loanAgainstShares';
import { buildBusinessLoanRmDetails } from '../flows/businessLoan';
import { EDITABLE_FIELDS, isEditableField, isFieldEditableNow, PROFILE_FIELDS } from '../flows/editableFields';
import { createSession, loadSession, persistAnswer, advanceCurrentStep, saveSession, logMessage, type SessionState } from '../services/session.service';
import { smsService } from '../services/sms.service';
import { FinfinityApiError } from '../services/finfinityClient';
import { goldLeadService } from '../services/goldLoan.service';
import { leadService } from '../services/lead.service';
import { personalLoanFinancerService, type PlFinancerLenderEntry } from '../services/personalLoanFinancer.service';
import { env } from '../config/env';
import { emailService } from '../services/email.service';
import { recallIdentity } from '../services/identity.service';
import { searchEmployers } from '../services/employer.service';
import { hmacLookup, maskMobile, maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { UserFacingError } from '../lib/userFacingError';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { z } from 'zod';

const FLOW = mainFlow;

function toCtx(state: SessionState, ip: string, userAgent?: string): StepContext {
  return { answers: state.answers, conversationId: state.conversationId, meta: { ip, userAgent } };
}

// Matches the whole (trimmed) answer, not a substring — so it only fires when that's clearly all
// the customer meant, not a coincidental word inside a longer, unrelated answer.
const RESTART_PATTERN = /^(start\s*over|restart(\s*(the\s*)?(chat|conversation|everything))?|start\s*again|reset(\s*(the\s*)?chat)?|new\s*(chat|conversation)?|begin\s*again)[.!]?$/i;

/** `identityToken` (only ever meaningful when starting a brand-new session) lets a customer who
 * verified mobile+OTP within the last 10 minutes skip straight past both — see
 * identity.service.ts and the 'intent'/'mobile'/'triggerOtpDedupe'/'otpDedupe' step guards in
 * homeLoan.ts. An unrecognized/expired/missing token just falls back to a normal blank session. */
async function beginNewSession(ip: string, userAgent: string | undefined, identityToken?: string): Promise<ChatTurnResponse> {
  const ctxAnswers: Record<string, unknown> = {};
  let mobileHash: string | undefined;
  let mobileMasked: string | undefined;

  if (identityToken) {
    const identity = await recallIdentity(identityToken);
    if (identity) {
      Object.assign(ctxAnswers, {
        intent: CHECK_ELIGIBILITY,
        mobile: identity.mobile,
        finfinityAccessToken: identity.finfinityAccessToken,
        finfinityRefreshToken: identity.finfinityRefreshToken,
        remoteCustomerId: identity.remoteCustomerId,
      });
      mobileHash = hmacLookup(identity.mobile);
      mobileMasked = maskMobile(identity.mobile);
    }
  }

  const firstId = applicablePath(FLOW, { answers: ctxAnswers, conversationId: '', meta: { ip } })[0].id;
  const state = await createSession(FLOW.id, firstId, { answers: ctxAnswers, mobileHash, mobileMasked, panConsent: mobileHash ? true : undefined });
  if (mobileHash) {
    // Same compliance trail the 'mobile' step's own onAnswer would have written — skipped here
    // since that step itself never runs for a resumed identity. Marked source: 'identity_resume'
    // (not the default 'mobile_step') since this isn't a fresh consent decision — see ConsentAudit's
    // own doc comment in schema.prisma.
    await prisma.consentAudit.create({ data: { conversationId: state.conversationId, decision: true, source: 'identity_resume', ipAddress: ip, userAgent } });
  }
  const ctx = toCtx(state, ip, userAgent);

  // A resumed identity can land the very FIRST applicable step on an auto ("none"-type) step like
  // dedupeCheck (normal fresh sessions always start on 'intent', an interactive step, so this
  // never came up before). Every other "none"-type step in this flow has its onAnswer run
  // immediately by advanceAndRender the moment it's reached — this is the one entry point that
  // skipped that, which meant its own onAnswer never ran at all: the client's next "continue" call
  // (matching the step it already saw) then treated dedupeCheck as already handled and walked
  // straight past it — past 'pan'/'profileFound' too, since dedupeFound was never actually set —
  // landing on the first step whose guard didn't need dedupeFound resolved (email), asking for
  // details a found customer already has on file.
  let errorText: string | undefined;
  const firstStep = getStep(FLOW, firstId);
  if (firstStep.input(ctx).type === 'none') {
    try {
      await runOnAnswer(firstId, undefined, ctx);
      state.answers = ctx.answers;
      await saveSession(state);
    } catch (err) {
      logger.error({ err, stepId: firstId, conversationId: state.conversationId }, 'first-step onAnswer failed for a new/resumed session');
      errorText = err instanceof UserFacingError ? err.message : EXTERNAL_SERVICE_ERROR_TEXT;
    }
  }

  const response = await render(state.currentStepId, state.sessionToken, ctx, errorText);
  if (response.botMessage) await logMessage(state.conversationId, 'bot', response.botMessage, state.currentStepId);
  return response;
}

/** The Message table is a full transcript kept for RM/analyst visibility — it must never hold a
 * secret or a raw PII value in plaintext, the same standard the rest of the app already holds PAN
 * (encrypted) and mobile (hashed) to. Logging the user's raw typed answer unconditionally would
 * have quietly stored real PANs, mobile numbers, and OTP codes in this table regardless. */
function redactForTranscript(stepType: string, value: string): string {
  if (stepType === 'otp') return '••••••';
  if (stepType === 'mobile') return maskMobile(value);
  if (stepType === 'pan') return maskPan(value.trim().toUpperCase());
  return value;
}

/** Runs a step's onAnswer (if any), merging any extra keys it returns into the session's answers. */
async function runOnAnswer(stepId: string, parsed: unknown, ctx: StepContext): Promise<void> {
  const step = getStep(FLOW, stepId);
  if (!step.onAnswer) return;
  const extras = await step.onAnswer(parsed, ctx);
  if (extras) {
    Object.assign(ctx.answers, extras);
    // Persisted under the flat key itself (not namespaced) so a Postgres rehydration after a
    // Redis TTL expiry reconstructs the exact same ctx.answers shape as the live hot state.
    // persistAnswer itself now decides what actually gets written vs. skipped/encrypted (see
    // session.service.ts's NEVER_PERSIST_KEYS/ENCRYPT_KEYS) — centralized there so every call site
    // (this one, the raw current-step answer below, and createSession's own seeding) gets the same
    // protection automatically instead of each needing its own copy of this check.
    for (const [k, v] of Object.entries(extras)) {
      await persistAnswer(ctx.conversationId, k, v);
    }
  }
}

/** renderStep + the one bit of extra state (the computed result payload) it doesn't know about — every
 * call site that might render the 'result' step goes through this so the payload is never forgotten. */
async function render(stepId: string, sessionToken: string, ctx: StepContext, errorText?: string): Promise<ChatTurnResponse> {
  const response = renderStep(FLOW, stepId, sessionToken, ctx, errorText);
  // Checked by step TYPE (not the literal id "result") so every product's own terminal step — each
  // has its own unique id, e.g. 'plResult'/'glResult'/'blResult' (see flows/personalLoan.ts etc.) —
  // gets the same treatment as homeLoan.ts's 'result' step, without homeLoan.ts needing to know
  // these other flows exist.
  const isResultType = getStep(FLOW, stepId).type === 'result';
  if (isResultType && ctx.answers.intent === CHECK_ELIGIBILITY) {
    response.result = ctx.answers.resultPayload;
    // Offer to share PAN for a lead/RM follow-up only when PAN is genuinely still unknown — the
    // Home Loan "declined PAN upfront" path is the only real case for this. Personal/Gold/Business
    // loan always already have a real PAN by their own result step (they branch off AFTER the full
    // identity chain — see personalLoan.ts's doc comment), so this naturally stays false for them
    // even when leadCreated is false for an unrelated reason — e.g. Gold Loan's real
    // "customer already has an active Muthoot lead" case (see goldLoan.service.ts) — where offering
    // to "share PAN" would be nonsensical since it's already fully known.
    const payload = ctx.answers.resultPayload as { leadCreated?: boolean; rm?: { name: string; phone: string; email: string }; product?: string; loanType?: string; leadId?: string } | undefined;
    response.panOffer = !payload?.leadCreated && !ctx.answers.pan;
    // The no-contact-consent branch never asked for a mobile number either — the offer needs to
    // collect one too before a lead/RM follow-up is even possible.
    response.panOfferNeedsMobile = !ctx.answers.mobile;

    // RM summary email — fired exactly once per conversation, the first time a lead (real or
    // dummy) actually exists, regardless of product. `rmSummaryEmailSent` guards against sending
    // again on every re-render of the same result step (widget polling, page refresh, etc.).
    if (payload?.leadCreated && payload.rm && !ctx.answers.rmSummaryEmailSent) {
      const product = payload.product ?? (ctx.answers.product as string | undefined) ?? 'Unknown';
      // Gold Loan/LAS send everything the customer answered; Business Loan sends everything except
      // PAN and CIBIL score (2026-10-21 instruction) — every other product still only gets the
      // generic rows above, unchanged.
      const productDetails =
        product === 'Gold Loan'
          ? buildGoldLoanRmDetails(ctx)
          : product === 'Loan Against Securities'
            ? buildLasRmDetails(ctx)
            : product === 'Business Loan'
              ? buildBusinessLoanRmDetails(ctx)
              : undefined;
      // Security-review finding, 2026-10-23: the "sent" flag used to be set BEFORE this call, so a
      // real SMTP failure (sendRmSummary logs and swallows its own error, see email.service.ts) was
      // marked permanently "done" anyway — the RM silently never heard about the lead with nothing
      // to retry it. Now only persisted once the send actually reports success.
      const sent = await emailService.sendRmSummary({
        // TEMPORARY (2026-10-21 instruction) — every send goes to RM_EMAIL_OVERRIDE_TO instead of
        // the real/fallback RM's own email, for test visibility. RM name/phone shown in the email
        // body are still the real assigned RM's — only the actual delivery address is overridden.
        rm: env.RM_EMAIL_OVERRIDE_TO ? { ...payload.rm, email: env.RM_EMAIL_OVERRIDE_TO } : payload.rm,
        customerName: ctx.answers.name as string | undefined,
        mobile: ctx.answers.mobile as string | undefined,
        customerEmail: ctx.answers.email as string | undefined,
        product,
        loanType: payload.loanType,
        leadId: payload.leadId,
        productDetails,
      });
      if (sent) {
        ctx.answers.rmSummaryEmailSent = true;
        await persistAnswer(ctx.conversationId, 'rmSummaryEmailSent', true);
      }
    }
  }
  if (isResultType && ctx.answers.intent === CHECK_EXISTING_APPLICATION) {
    // The status branch otherwise dead-ends here — offer a way back into either flow instead of
    // leaving "Start over" (which re-asks the intent question) as the only option.
    response.statusCheck = true;
  }
  if (ctx.answers.identityToken) response.identityToken = ctx.answers.identityToken as string;
  return response;
}

const OTP_STEP_IDS = ['otpDedupe', 'otpBureauFound', 'otpBureauNotFound', 'otpPanDuplicateVerify', 'otpEmailDuplicateVerify'];

/** A step's onAnswer throwing here almost always means an external call failed (a real bank API
 * timing out, erroring, or being unreachable) — never something the customer did wrong. Shown as
 * a generic, friendly message rather than the underlying error (which may name an internal
 * service/endpoint), and logged with enough detail on the server side to actually debug it. */
const EXTERNAL_SERVICE_ERROR_TEXT = "We're having trouble reaching one of our services right now. Please try again in a moment.";

/** Advances currentStepId forward one step, executing the new step's onAnswer immediately (see architecture notes). */
async function advanceAndRender(state: SessionState, fromStepId: string, ctx: StepContext): Promise<ChatTurnResponse> {
  const nextId = nextStepId(FLOW, fromStepId, ctx);
  if (!nextId) {
    // Shouldn't happen — 'result' is always the last applicable step — but fail safe by re-rendering current.
    return await render(fromStepId, state.sessionToken, ctx);
  }
  // Only auto-executing steps (input type "none" — apiFetch/message/result) run their onAnswer
  // immediately on arrival, since there's no user input to wait for. Interactive steps (mobile,
  // otp, choice, etc.) must wait until the user actually submits a value for THAT step — handled
  // in the main route handler, not here.
  const nextStep = getStep(FLOW, nextId);
  if (nextStep.input(ctx).type === 'none') {
    try {
      await runOnAnswer(nextId, undefined, ctx);
    } catch (err) {
      // Nothing about `state`/`ctx.answers` has been mutated for this step yet (the throw happens
      // before any of that below), so it's safe to just re-render the step the customer was
      // already sitting on, with a friendly error — same as an interactive step's onAnswer failing.
      logger.error({ err, stepId: nextId, conversationId: ctx.conversationId }, 'auto-step onAnswer failed');
      const errorText = err instanceof UserFacingError ? err.message : EXTERNAL_SERVICE_ERROR_TEXT;
      const response = await render(fromStepId, state.sessionToken, ctx, errorText);
      if (err instanceof UserFacingError && err.action) response.errorAction = err.action;
      return response;
    }
  }
  state.currentStepId = nextId;
  state.answers = ctx.answers;
  await advanceCurrentStep(ctx.conversationId, nextId);
  await saveSession(state);

  const response = await render(nextId, state.sessionToken, ctx);
  if (response.botMessage) await logMessage(ctx.conversationId, 'bot', response.botMessage, nextId);
  return response;
}

interface EditOutcome {
  ok: boolean;
  error?: string;
  display?: string;
  resultPayload?: unknown;
  /** A new chat-log entry confirming what changed — shown as its own bot bubble, not folded
   * silently into the sidebar, so the transcript actually reflects that (and what) was edited. */
  summaryMessage?: string;
  /** A second bubble right after, since the whole point of the edit was to see how it changed
   * the number — explicitly says so when it now comes back ineligible, rather than the result
   * card silently going blank where the sanction amount used to be. */
  eligibilityMessage?: string;
}

/** Called by the profile-panel edit endpoint (/api/chat/edit) — the only real way a customer
 * revises an answer after the fact; there's no free-text "change my income to 90000" chat parser
 * anywhere (confirmed 2026-10-17 — an earlier comment here implied one existed). Revalidates
 * through the field's own step definition (so an edit can never bypass the rules a fresh answer
 * would have to pass), then re-runs eligibility math if a result already exists. */
async function applyFieldEdit(state: SessionState, ctx: StepContext, field: string, rawValue: string): Promise<EditOutcome> {
  if (!isEditableField(field)) return { ok: false, error: 'That detail can\'t be edited directly — start a new check if it needs to change.' };
  // An existing (dedupe-found) customer's segment/pincode/email came from Finfinity's own
  // verified records — only income/emi (always self-declared either way) stay editable for them.
  if (!isFieldEditableNow(ctx, field)) {
    return { ok: false, error: "That detail is on file with your verified profile and can't be edited here — only income and existing EMIs can." };
  }

  const step = getStep(FLOW, field);
  const validation = step.validate?.(rawValue, ctx) ?? { ok: true, parsed: rawValue };
  if (!validation.ok) return { ok: false, error: validation.error };
  // Known gap, not fixed here (security-review finding, 2026-10-23): this only re-validates an
  // edited email's FORMAT, not whether it belongs to a different existing customer — the real
  // duplicate-email check only runs during initial signup (emailDuplicateCheck in homeLoan.ts),
  // which is a multi-step OTP-gated flow (check -> choice -> verify), not a single validator
  // function this edit path could just call inline. Wiring a profile-panel edit into that same
  // multi-step flow would need real restructuring (the edit endpoint would have to hand control
  // back to the conversation's step machine mid-edit) — left alone rather than attempting that
  // under this batch of fixes; flag for a follow-up if email-duplicate-on-edit matters in practice.

  ctx.answers[field] = validation.parsed;
  await persistAnswer(ctx.conversationId, field, validation.parsed);

  const fieldDef = EDITABLE_FIELDS.find((f) => f.key === field)!;
  const outcome: EditOutcome = { ok: true, display: fieldDef.format(ctx) };
  outcome.summaryMessage = `Got it — ${fieldDef.label} updated to ${outcome.display}.`;
  await logMessage(ctx.conversationId, 'bot', outcome.summaryMessage);

  // Security-review finding, 2026-10-23: this used to call Home Loan's own recomputeEligibility
  // unconditionally for ANY product's edit — editing a Business Loan address, or income/pincode/
  // email on a Personal or Gold Loan result, ran Home Loan's eligibility math against data it was
  // never designed to read, which usually came back "no eligibility" and silently replaced a real
  // result with a wrong one. Home Loan/LAP (the product recomputeEligibility actually exists for)
  // keeps the real recompute; every other product's editable fields (segment/income/emi/pincode/
  // email, and Business Loan's address) don't feed into that product's own eligibility math anyway
  // (Personal Loan's offers come from a real, non-idempotent BRE call chain that isn't safe to
  // re-fire on every edit; Gold Loan's cap comes from gold weight/purity, neither of which is
  // editable here; Business Loan/LAS have no eligibility math at all, just a lead) — so for those,
  // the answer is saved and the existing result is left exactly as it was instead of being
  // reached into with the wrong product's formula.
  const product = ctx.answers.product as string | undefined;
  const isHomeLoanOrLap = !product || product === 'Home loan' || product === 'Loan against property';
  if (ctx.answers.resultPayload && isHomeLoanOrLap) {
    const updated = await recomputeEligibility(ctx, ctx.answers.resultPayload as any);
    ctx.answers.resultPayload = updated;
    await persistAnswer(ctx.conversationId, 'resultPayload', updated);
    outcome.resultPayload = updated;
    outcome.eligibilityMessage = (updated as { eligible?: boolean }).eligible
      ? "Here's your updated eligibility."
      : "Based on this update, there's no eligibility for your profile right now.";
    await logMessage(ctx.conversationId, 'bot', outcome.eligibilityMessage);
  }

  state.answers = ctx.answers;
  await saveSession(state);
  return outcome;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post('/api/chat/message', async (req, reply) => {
    const body = ChatMessageRequest.parse(req.body ?? {});
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];

    // --- Brand new session ---
    if (!body.sessionToken) {
      return reply.send(await beginNewSession(ip, userAgent, body.identityToken));
    }

    const state = await loadSession(body.sessionToken);
    if (!state) {
      return reply.code(404).send({ error: 'session_not_found', message: 'This session has expired. Please start again.' });
    }

    const ctx = toCtx(state, ip, userAgent);
    const currentStep = getStep(FLOW, state.currentStepId);

    // No stepId at all means "just tell me where I am" — a fresh page load resuming an existing
    // session via a stored sessionToken. Never treat this as an answer submission (an interactive
    // step's validate() would otherwise see an empty value and show a spurious error).
    // A stale/replayed stepId that doesn't match is handled the same way: just re-sync the client.
    if (!body.stepId || body.stepId !== state.currentStepId) {
      return reply.send(await render(state.currentStepId, state.sessionToken, ctx));
    }

    // A customer typing "start over"/"restart"/etc. as their answer to whatever question is on
    // screen wants a fresh conversation, not to have that phrase validated as an actual answer to
    // the current step (which would usually just show a validation error and confuse them).
    if (typeof body.value === 'string' && RESTART_PATTERN.test(body.value.trim())) {
      return reply.send(await beginNewSession(ip, userAgent, body.identityToken));
    }

    const inputSpec = currentStep.input(ctx);

    // --- "Continue" signal for an already-rendered auto step (apiFetch/message) — no value to validate. ---
    if (inputSpec.type === 'none' && currentStep.type !== 'result') {
      const response = await advanceAndRender(state, state.currentStepId, ctx);
      return reply.send(response);
    }
    if (currentStep.type === 'result') {
      // Terminal step — nothing more to validate, just re-serve the current result (e.g. a
      // page-reload resync, or the idempotent "continue" the widget sends after rendering it).
      return reply.send(await render(state.currentStepId, state.sessionToken, ctx));
    }

    // --- Interactive step: validate the user's answer ---
    if (body.value !== undefined) {
      await logMessage(ctx.conversationId, 'user', redactForTranscript(currentStep.type, body.value), state.currentStepId);
    }
    const validation = currentStep.validate?.(body.value, ctx) ?? { ok: true, parsed: body.value };

    if (!validation.ok) {
      // Persist ctx.answers even on a failed validation — validateChoice() may have stashed a
      // "did you mean X?" suggestion on it, which needs to survive until the next message.
      await saveSession(state);
      const response = await render(state.currentStepId, state.sessionToken, ctx, validation.error);
      return reply.send(response);
    }

    // --- Valid answer: run side effects, persist, advance ---
    try {
      await runOnAnswer(state.currentStepId, validation.parsed, ctx);
    } catch (err) {
      // Every current interactive step's onAnswer only ever throws its own deliberately
      // customer-safe messages (e.g. "Incorrect OTP" — none of which are UserFacingError, just
      // plain Errors written to be shown as-is) — but a future step wired to a real external call
      // must not leak that call's raw error text, so the same allow-list applies here too.
      const knownSafeMessages = ['Incorrect OTP. Please try again.', 'Too many incorrect attempts. Please request a new OTP.'];
      const message = err instanceof UserFacingError || (err instanceof Error && knownSafeMessages.includes(err.message)) ? (err as Error).message : EXTERNAL_SERVICE_ERROR_TEXT;
      if (message === EXTERNAL_SERVICE_ERROR_TEXT) logger.error({ err, stepId: state.currentStepId, conversationId: ctx.conversationId }, 'interactive-step onAnswer failed');
      const response = await render(state.currentStepId, state.sessionToken, ctx, message);
      return reply.send(response);
    }

    ctx.answers[state.currentStepId] = validation.parsed;
    await persistAnswer(ctx.conversationId, state.currentStepId, validation.parsed);
    state.answers = ctx.answers;

    const response = await advanceAndRender(state, state.currentStepId, ctx);
    return reply.send(response);
  });

  app.post('/api/chat/resend-otp', async (req, reply) => {
    const body = ChatMessageRequest.pick({ sessionToken: true }).parse(req.body ?? {});
    if (!body.sessionToken) return reply.code(400).send({ error: 'missing_session_token' });

    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ error: 'session_not_found', message: 'This session has expired. Please start again.' });
    if (!OTP_STEP_IDS.includes(state.currentStepId) || !state.answers.mobile) {
      return reply.code(409).send({ error: 'not_awaiting_otp' });
    }

    const cooldownKey = `otp:resend-cooldown:${state.conversationId}`;
    // Security-review finding, 2026-10-23: this used to read the cooldown key, then only set it
    // later after a successful send — two resend clicks arriving close enough together could both
    // read "no cooldown" before either one set it, letting both through as real sends. SET ... NX
    // claims the cooldown atomically in the same call that checks it, so only one concurrent request
    // can ever win. If the send itself then fails for a reason OTHER than the real backend's own
    // cooldown, the claim is released below so the customer isn't stuck waiting on a resend that
    // never actually went out.
    const claimed = await redis.set(cooldownKey, '1', 'EX', 30, 'NX');
    if (!claimed) return reply.code(429).send({ error: 'resend_too_soon', message: 'Please wait a bit before requesting another OTP.' });

    try {
      await smsService.sendOtp(state.conversationId, state.answers.mobile as string);
    } catch (err) {
      // The real Finfinity backend has its OWN resend cooldown (OTPWAIT, commonly ~60s — longer
      // than our own 30s Redis cooldown above), so this can legitimately fire even once our own
      // cooldown has expired. Previously unhandled here — any error, including this expected one,
      // crashed to a generic 500. Surface it the same safe way as the cooldown check above instead.
      if (err instanceof FinfinityApiError && err.code === 'OTPWAIT') {
        return reply.code(429).send({ error: 'resend_too_soon', message: 'Please wait a bit before requesting another OTP.' });
      }
      await redis.del(cooldownKey);
      logger.error({ err, event: 'resend_otp_failed' }, 'resend-otp failed');
      return reply.code(502).send({ error: 'resend_failed', message: "Couldn't resend the OTP right now — please try again shortly." });
    }
    return reply.send({ ok: true });
  });

  // Security-review finding, 2026-10-23: see ChatMessageRequest's own comment in shared/src/index.ts
  // — same reasoning, applied to this route's own request schemas.
  const EditRequest = z.object({ sessionToken: z.string().max(128), field: z.string().max(100), value: z.string().max(1000) });

  app.post('/api/chat/edit', async (req, reply) => {
    const body = EditRequest.parse(req.body ?? {});
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ ok: false, error: 'This session has expired. Please start again.' });

    const ctx = toCtx(state, req.ip, req.headers['user-agent']);
    const outcome = await applyFieldEdit(state, ctx, body.field, body.value);
    return reply.send(outcome);
  });

  /** Fired when the customer taps the Gold Loan submit card — the ENTIRE real submission to
   * Finfinity/Muthoot happens here now (create_anacity_lead + setmuthootlenderoffer +
   * muthootleadgeneration, see services/goldLoan.service.ts's submitApplication), not before.
   * Redesigned 2026-10-15: previously lead creation + lender attach happened silently as soon as
   * glResult was reached, before any customer action — meaning a customer who never clicked submit
   * still had a real lead permanently blocking any future real attempt (Finfinity allows only one
   * Muthoot lead per customer). Nothing real touches Finfinity until this one explicit click now. */
  app.post('/api/chat/gold-submit', async (req, reply) => {
    const body = ChatMessageRequest.pick({ sessionToken: true }).parse(req.body ?? {});
    if (!body.sessionToken) return reply.code(400).send({ ok: false, error: 'missing_session_token' });

    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ ok: false, error: 'This session has expired. Please start again.' });
    const resultPayload = state.answers.resultPayload as { eligible?: boolean; leadId?: string; rm?: { name: string; phone: string; email: string } } | undefined;
    if (state.currentStepId !== 'glResult' || !resultPayload?.eligible) {
      return reply.code(409).send({ ok: false, error: 'not_awaiting_gold_submit' });
    }
    // The real lead (and real RM) were already created the moment this branch was entered
    // (glCreateLead, see flows/goldLoan.ts) — this endpoint only attaches Muthoot and submits,
    // the two calls that actually consume Finfinity's "one Muthoot lead per customer" slot. The RM
    // summary email already fired back when glResult first rendered (same generic path every other
    // product uses, right above in this file) — nothing to send again here.
    if (!resultPayload.leadId || !resultPayload.rm) {
      return reply.code(409).send({ ok: false, error: 'no_lead_for_gold_submit' });
    }

    const result = await goldLeadService.submitApplication({
      leadId: resultPayload.leadId,
      rm: resultPayload.rm,
      token: state.answers.finfinityAccessToken as string | undefined,
    });

    return reply.send(result);
  });

  const SelectOfferRequest = z.object({ sessionToken: z.string().max(128), lenderName: z.string().max(100) });

  /** Fired when the customer picks a specific lender's offer on a result screen — POST
   * /leadflow/setbrefinanceroffertenure, confirmed live (2026-10-15) to work identically for Home
   * Loan, LAP, and Personal Loan (see lead.service.ts's setOfferTenure doc comment). Home Loan/LAP
   * already have a real lead by this point (created earlier in their own flow); Personal Loan does
   * not yet — its real lead is created HERE, lazily, via create_anacity_lead (2026-10-16 — switched
   * from createcorplead, which never returned an RM), only because the customer explicitly picked
   * an offer, same "nothing real until explicit action" principle as Gold Loan's submit click. */
  app.post('/api/chat/select-offer', async (req, reply) => {
    const body = SelectOfferRequest.parse(req.body ?? {});
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ ok: false, error: 'This session has expired. Please start again.' });

    const isResultStep = getStep(FLOW, state.currentStepId)?.type === 'result';
    const payload = state.answers.resultPayload as EligibilityResultPayload | undefined;
    if (!isResultStep || !payload?.offers?.length) {
      return reply.code(409).send({ ok: false, error: 'not_awaiting_offer_select' });
    }

    const offer = payload.offers.find((o) => o.name === body.lenderName);
    if (!offer) return reply.code(400).send({ ok: false, error: 'unknown_lender' });

    const ctx = toCtx(state, req.ip, req.headers['user-agent']);
    const token = ctx.answers.finfinityAccessToken as string | undefined;
    let leadId = payload.leadId;
    let rm: { name: string; phone: string; email: string } | undefined;
    if (!leadId) {
      const lead = await leadService.createLead({
        conversationId: ctx.conversationId,
        panMasked: maskPan(ctx.answers.pan as string),
        name: ctx.answers.name as string | undefined,
        mobileMasked: ctx.answers.mobile ? maskMobile(ctx.answers.mobile as string) : undefined,
        creditScore: ctx.answers.creditScore as number | undefined,
        product: payload.product,
        loanType: payload.loanType,
        remoteCustomerId: ctx.answers.remoteCustomerId as number | undefined,
        token,
      });
      if (!lead.builderLeadId) return reply.code(502).send({ ok: false, error: 'lead_creation_failed' });
      leadId = lead.builderLeadId;
      rm = lead.rm;
      payload.leadId = leadId;
      payload.leadCreated = true;
      if (rm) payload.rm = rm;
      ctx.answers.resultPayload = payload;
      await persistAnswer(ctx.conversationId, 'resultPayload', payload);
    }

    // Personal Loan's real financer chain (off by default — see personalLoanFinancer.service.ts)
    // needs two extra calls (setcorpamtten + pl_financer_offer) before the tenure can be confirmed
    // — writes the customer's chosen lender/amount/tenure onto the lead, then recomputes the final
    // numbers for exactly that selection. Every other product skips straight to setOfferTenure, same
    // as before this chain existed.
    if (payload.product === 'Personal Loan' && env.PL_REAL_FINANCER_CHAIN_ENABLED) {
      const rawByLender = ctx.answers.plFinancerRawByLender as Record<string, PlFinancerLenderEntry> | undefined;
      const lender = rawByLender?.[body.lenderName];
      if (!lender) return reply.code(500).send({ ok: false, error: 'missing_financer_lender_data' });
      await personalLoanFinancerService.confirmOffer({
        leadId,
        lender,
        requestedLoanAmount: Number(ctx.answers.plLoanAmount),
        requestedTenureMonths: offer.tenureYears * 12,
        token,
      });
    }

    await leadService.setOfferTenure(leadId, offer.tenureYears * 12, token);
    return reply.send({ ok: true, leadId, rm });
  });

  const PanOfferRequest = z.object({
    sessionToken: z.string().max(128),
    decision: z.enum(['decline']).optional(),
    pan: z.string().max(20).optional(),
    mobile: z.string().max(20).optional(),
  });

  /** Post-eligibility offer for anyone who declined PAN up front (and, for the no-contact-consent
   * branch, mobile too): "decision: decline" just dismisses it, a valid "pan" (plus "mobile" when
   * missing) creates the lead from the already-computed result — no OTP/bureau pull here, just
   * identity + the numbers already on screen. */
  app.post('/api/chat/pan-offer', async (req, reply) => {
    const body = PanOfferRequest.parse(req.body ?? {});
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ ok: false, error: 'This session has expired. Please start again.' });
    if (state.currentStepId !== 'result' || !state.answers.resultPayload) {
      return reply.code(409).send({ ok: false, error: 'not_awaiting_pan_offer' });
    }

    const ctx = toCtx(state, req.ip, req.headers['user-agent']);

    if (body.decision === 'decline') {
      return reply.send({ ok: true });
    }

    // Security-review finding, 2026-10-23: this used to let a second /pan-offer call through
    // unconditionally — ensureLead (called below via createLeadFromResult) already stops a SECOND
    // real lead from being created, but it also means a PAN submitted here after one was already on
    // file just got silently swapped into ctx.answers.pan/resultPayload while the real lead (and its
    // Lead row) stayed registered under the FIRST PAN — the customer-facing state and the actual
    // Finfinity lead would then disagree about whose PAN this application is under. A PAN is already
    // on file either from the normal consent flow or from an earlier pan-offer call, so there's
    // nothing left for this endpoint to do.
    if (ctx.answers.pan) {
      return reply.code(409).send({ ok: false, error: 'A PAN is already on file for this application.' });
    }

    if (!ctx.answers.mobile) {
      const mobile = (body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return reply.code(400).send({ ok: false, error: 'Enter a valid 10-digit mobile number.' });
      }
      ctx.answers.mobile = mobile;
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { mobileHash: hmacLookup(mobile), mobileMasked: maskMobile(mobile) },
      });
      await persistAnswer(ctx.conversationId, 'mobile', mobile);
    }

    const pan = (body.pan || '').trim().toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) {
      return reply.code(400).send({ ok: false, error: 'Enter a valid PAN, e.g. ABCDE1234F.' });
    }

    const updated = await createLeadFromResult(ctx, ctx.answers.resultPayload as any, {
      pan,
      name: ctx.answers.name as string | undefined,
      creditScore: ctx.answers.creditScore as number | undefined,
    });
    ctx.answers.pan = pan;
    ctx.answers.resultPayload = updated;
    await persistAnswer(ctx.conversationId, 'pan', pan);
    await persistAnswer(ctx.conversationId, 'resultPayload', updated);
    state.answers = ctx.answers;
    await saveSession(state);

    return reply.send({ ok: true, resultPayload: updated });
  });

  /** What the live profile panel renders — every editable field's current value (blank if not yet answered). */
  app.post('/api/chat/profile', async (req, reply) => {
    const body = ChatMessageRequest.pick({ sessionToken: true }).parse(req.body ?? {});
    if (!body.sessionToken) return reply.code(400).send({ error: 'missing_session_token' });
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ error: 'session_not_found' });

    const ctx = toCtx(state, req.ip, req.headers['user-agent']);
    const fields = PROFILE_FIELDS.map((f) => ({ key: f.key, label: f.label, editable: f.editable(ctx), value: f.format(ctx) })).filter((f) => f.value !== '');
    return reply.send({ fields });
  });

  // Backs every 'typeahead'-type step's input (see InputSpec in shared) — `searchKey` picks which
  // server-side list to search; add a new entry here when a second typeahead-backed field shows up.
  const TYPEAHEAD_SEARCHERS: Record<string, (query: string) => string[]> = { employer: searchEmployers };
  const TypeaheadSearchRequest = z.object({ searchKey: z.string().max(50), query: z.string().max(100) });
  app.post('/api/chat/typeahead-search', async (req, reply) => {
    const body = TypeaheadSearchRequest.parse(req.body ?? {});
    const search = TYPEAHEAD_SEARCHERS[body.searchKey];
    if (!search) return reply.code(400).send({ error: 'unknown_search_key' });
    return reply.send({ matches: search(body.query) });
  });
}
