import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Answers } from '../flow-engine/types';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { encryptPii, decryptPii } from '../lib/crypto';

const SESSION_TTL_SECONDS = 10 * 60; // sliding window — "context not wasted" for a short return visit

// Security-review finding, 2026-10-23: Postgres-rehydration below had no age cutoff at all — a
// `sessionToken` from months ago, leaked however (a shared/public device, a logged URL, a browser
// history entry), would rehydrate the full conversation forever, with no expiry ever kicking in.
// 30 days is generous for any real return visit while still giving old tokens a real expiry.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Security-review finding, 2026-10-23: persistAnswer used to write every answer to Postgres's
 * durable FlowAnswer table completely as-is — OTP digits, raw PAN, mobile, the Finfinity
 * access/refresh tokens, all in plain readable text, readable by anyone with DB access (a backup, a
 * leaked credential, etc.), and reusable to impersonate that customer in Finfinity's own system.
 * This contradicted the Lead table's own panEncrypted column a few lines away, which already proves
 * the codebase knows how to do this properly — it just wasn't applied here. Two kinds of fix, one
 * per kind of value:
 *
 * 1. NEVER_PERSIST_KEYS — values with no legitimate reason to survive a Redis TTL expiry: the raw
 *    OTP code someone just typed (single-use, worthless after verification either way), the live
 *    Finfinity access/refresh tokens (short-lived, refreshed via a new OTP/bureau round anyway), our
 *    own "remembered identity" token (a bearer-style shortcut that skips OTP entirely if replayed —
 *    no safer in a durable table than the tokens above), and `duplicateMatch` (can carry a
 *    completely DIFFERENT customer's PII during a dedupe-collision — was already excluded here,
 *    just folded into this same list instead of living as its own one-off set in chat.ts). Redis's
 *    own TTL already covers the one real need (surviving mid-conversation), and these aren't needed
 *    after that window closes.
 * 2. ENCRYPT_KEYS — values that DO need to survive a cold cache / long gap (so a customer's progress
 *    isn't lost), encrypted at rest with the same AES-GCM `encryptPii`/`PII_ENCRYPTION_KEY` the Lead
 *    table already uses, decrypted back on the Postgres-rehydration path in loadSession below.
 *
 * Everything else (loan amounts, choices, GST lookups, etc.) is unaffected — none of it is a secret. */
const NEVER_PERSIST_KEYS = new Set([
  'otpDedupe',
  'otpPanDuplicateVerify',
  'otpEmailDuplicateVerify',
  'otpBureauFound',
  'otpBureauNotFound',
  'finfinityAccessToken',
  'finfinityRefreshToken',
  'identityToken',
  'duplicateMatch',
]);
const ENCRYPT_KEYS = new Set(['pan', 'blPan', 'mobile', 'dob', 'email']);

export interface SessionState {
  conversationId: string;
  sessionToken: string;
  flowId: string;
  currentStepId: string;
  answers: Answers;
}

function sessionKey(sessionToken: string) {
  return `session:${sessionToken}`;
}

export async function createSession(
  flowId: string,
  firstStepId: string,
  opts?: { answers?: Answers; mobileHash?: string; mobileMasked?: string; panConsent?: boolean },
): Promise<SessionState> {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const conversation = await prisma.conversation.create({
    data: {
      sessionToken,
      flowId,
      currentStepId: firstStepId,
      mobileHash: opts?.mobileHash,
      mobileMasked: opts?.mobileMasked,
      panConsent: opts?.panConsent,
    },
  });
  const state: SessionState = {
    conversationId: conversation.id,
    sessionToken,
    flowId,
    currentStepId: firstStepId,
    answers: opts?.answers ?? {},
  };
  await saveSession(state);
  // So a later Redis-TTL rehydration (loadSession's Postgres fallback) reconstructs the same
  // seeded answers, not a blank slate — same reasoning as runOnAnswer's persistAnswer calls.
  if (opts?.answers) {
    for (const [stepId, value] of Object.entries(opts.answers)) {
      await persistAnswer(conversation.id, stepId, value);
    }
  }
  return state;
}

/** Redis is the fast path; on a cold cache (TTL expiry) we rehydrate from Postgres so no progress is lost. */
export async function loadSession(sessionToken: string): Promise<SessionState | null> {
  const cached = await redis.get(sessionKey(sessionToken));
  if (cached) {
    await redis.expire(sessionKey(sessionToken), SESSION_TTL_SECONDS);
    return JSON.parse(cached) as SessionState;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { sessionToken },
    include: { answers: true },
  });
  if (!conversation || !conversation.currentStepId) return null;
  if (Date.now() - conversation.createdAt.getTime() > SESSION_MAX_AGE_MS) return null;

  const answers: Answers = {};
  for (const a of conversation.answers) {
    // Mirrors persistAnswer's own encryption below — decrypt back on the way out, same keys.
    answers[a.stepId] = ENCRYPT_KEYS.has(a.stepId) && typeof a.value === 'string' ? decryptPii(a.value) : a.value;
  }

  const state: SessionState = {
    conversationId: conversation.id,
    sessionToken,
    flowId: conversation.flowId,
    currentStepId: conversation.currentStepId,
    answers,
  };
  await saveSession(state);
  return state;
}

export async function saveSession(state: SessionState): Promise<void> {
  await redis.set(sessionKey(state.sessionToken), JSON.stringify(state), 'EX', SESSION_TTL_SECONDS);
}

export async function persistAnswer(conversationId: string, stepId: string, value: unknown): Promise<void> {
  // See NEVER_PERSIST_KEYS's own doc comment above — these never touch Postgres at all, Redis's
  // session TTL is the only place they ever need to live.
  if (NEVER_PERSIST_KEYS.has(stepId)) return;

  // A step can validly resolve to "no value" (e.g. scoreBand's "not sure") — Prisma's Json column
  // rejects a bare `undefined` (it must be an actual JSON value), so it needs the explicit
  // JsonNull sentinel instead, or upsert() throws and the whole request — including advancing
  // past this step — fails.
  const encrypted = ENCRYPT_KEYS.has(stepId) && typeof value === 'string' ? encryptPii(value) : value;
  const jsonValue = encrypted === undefined ? Prisma.JsonNull : (encrypted as Prisma.InputJsonValue);
  await prisma.flowAnswer.upsert({
    where: { conversationId_stepId: { conversationId, stepId } },
    create: { conversationId, stepId, value: jsonValue },
    update: { value: jsonValue },
  });
}

export async function advanceCurrentStep(conversationId: string, stepId: string): Promise<void> {
  await prisma.conversation.update({ where: { id: conversationId }, data: { currentStepId: stepId } });
}

export async function logMessage(conversationId: string, role: 'bot' | 'user' | 'system', text: string, stepId?: string): Promise<void> {
  await prisma.message.create({ data: { conversationId, role, text, stepId } });
}
