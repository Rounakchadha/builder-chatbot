import type { FastifyInstance } from 'fastify';
import { ChatMessageRequest, CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse } from '@loan-chatbot/shared';
import { applicablePath, getStep, nextStepId, renderStep } from '../flow-engine/engine';
import type { StepContext } from '../flow-engine/types';
import { homeLoanFlow, recomputeEligibility, createLeadFromResult } from '../flows/homeLoan';
import { EDITABLE_FIELDS, isEditableField, isFieldEditableNow, PROFILE_FIELDS } from '../flows/editableFields';
import { createSession, loadSession, persistAnswer, advanceCurrentStep, saveSession, logMessage, type SessionState } from '../services/session.service';
import { smsService } from '../services/sms.service';
import { recallIdentity } from '../services/identity.service';
import { hmacLookup, maskMobile, maskPan } from '../lib/crypto';
import { logger } from '../lib/logger';
import { UserFacingError } from '../lib/userFacingError';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { z } from 'zod';

const FLOW = homeLoanFlow;

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
    // since that step itself never runs for a resumed identity.
    await prisma.consentAudit.create({ data: { conversationId: state.conversationId, decision: true, ipAddress: ip, userAgent } });
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

  const response = render(state.currentStepId, state.sessionToken, ctx, errorText);
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

/** Keys that must never reach the permanent FlowAnswer table (Postgres) — kept only in the live,
 * TTL'd Redis session state, for the rest of THIS conversation. `duplicateMatch` in particular can
 * carry a completely DIFFERENT customer's real name/DOB/email/mobile/credit score (see
 * dedupe.service.ts's DuplicateMatch) — every other place in this codebase encrypts or masks PAN/
 * mobile before it's ever written to a durable table; this is the one path that would otherwise
 * write a third party's PII in plaintext into someone else's permanent conversation record. */
const TRANSIENT_ANSWER_KEYS = new Set(['duplicateMatch']);

/** Runs a step's onAnswer (if any), merging any extra keys it returns into the session's answers. */
async function runOnAnswer(stepId: string, parsed: unknown, ctx: StepContext): Promise<void> {
  const step = getStep(FLOW, stepId);
  if (!step.onAnswer) return;
  const extras = await step.onAnswer(parsed, ctx);
  if (extras) {
    Object.assign(ctx.answers, extras);
    // Persisted under the flat key itself (not namespaced) so a Postgres rehydration after a
    // Redis TTL expiry reconstructs the exact same ctx.answers shape as the live hot state.
    for (const [k, v] of Object.entries(extras)) {
      if (TRANSIENT_ANSWER_KEYS.has(k)) continue;
      await persistAnswer(ctx.conversationId, k, v);
    }
  }
}

/** renderStep + the one bit of extra state (the computed result payload) it doesn't know about — every
 * call site that might render the 'result' step goes through this so the payload is never forgotten. */
function render(stepId: string, sessionToken: string, ctx: StepContext, errorText?: string): ChatTurnResponse {
  const response = renderStep(FLOW, stepId, sessionToken, ctx, errorText);
  if (stepId === 'result' && ctx.answers.intent === CHECK_ELIGIBILITY) {
    response.result = ctx.answers.resultPayload;
    // Offer to share PAN for a lead/RM follow-up only when it wasn't already shared/on file (and
    // hasn't already been shared via this same offer) — computeResultPayload only auto-creates a
    // lead when a PAN was already known, so this is the one path back to a lead for everyone else.
    response.panOffer = !ctx.answers.pan;
    // The no-contact-consent branch never asked for a mobile number either — the offer needs to
    // collect one too before a lead/RM follow-up is even possible.
    response.panOfferNeedsMobile = !ctx.answers.mobile;
  }
  if (stepId === 'result' && ctx.answers.intent === CHECK_EXISTING_APPLICATION) {
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
    return render(fromStepId, state.sessionToken, ctx);
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
      const response = render(fromStepId, state.sessionToken, ctx, errorText);
      if (err instanceof UserFacingError && err.action) response.errorAction = err.action;
      return response;
    }
  }
  state.currentStepId = nextId;
  state.answers = ctx.answers;
  await advanceCurrentStep(ctx.conversationId, nextId);
  await saveSession(state);

  const response = render(nextId, state.sessionToken, ctx);
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

/** Shared by the profile-panel edit endpoint and chat-based "change my income to 90000" edits —
 * revalidates through the field's own step definition (so an edit can never bypass the rules a
 * fresh answer would have to pass), then re-runs eligibility math if a result already exists. */
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

  ctx.answers[field] = validation.parsed;
  await persistAnswer(ctx.conversationId, field, validation.parsed);

  const fieldDef = EDITABLE_FIELDS.find((f) => f.key === field)!;
  const outcome: EditOutcome = { ok: true, display: fieldDef.format(ctx) };
  outcome.summaryMessage = `Got it — ${fieldDef.label} updated to ${outcome.display}.`;
  await logMessage(ctx.conversationId, 'bot', outcome.summaryMessage);

  if (ctx.answers.resultPayload) {
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
      return reply.send(render(state.currentStepId, state.sessionToken, ctx));
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
      return reply.send(render(state.currentStepId, state.sessionToken, ctx));
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
      const response = render(state.currentStepId, state.sessionToken, ctx, validation.error);
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
      const response = render(state.currentStepId, state.sessionToken, ctx, message);
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
    const onCooldown = await redis.get(cooldownKey);
    if (onCooldown) return reply.code(429).send({ error: 'resend_too_soon', message: 'Please wait a bit before requesting another OTP.' });

    await smsService.sendOtp(state.conversationId, state.answers.mobile as string);
    await redis.set(cooldownKey, '1', 'EX', 30);
    return reply.send({ ok: true });
  });

  const EditRequest = z.object({ sessionToken: z.string(), field: z.string(), value: z.string() });

  app.post('/api/chat/edit', async (req, reply) => {
    const body = EditRequest.parse(req.body ?? {});
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ ok: false, error: 'This session has expired. Please start again.' });

    const ctx = toCtx(state, req.ip, req.headers['user-agent']);
    const outcome = await applyFieldEdit(state, ctx, body.field, body.value);
    return reply.send(outcome);
  });

  const PanOfferRequest = z.object({
    sessionToken: z.string(),
    decision: z.enum(['decline']).optional(),
    pan: z.string().optional(),
    mobile: z.string().optional(),
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
}
