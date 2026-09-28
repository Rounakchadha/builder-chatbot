import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Answers } from '../flow-engine/types';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

const SESSION_TTL_SECONDS = 30 * 60; // sliding window — "context not wasted" for a short return visit

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

  const answers: Answers = {};
  for (const a of conversation.answers) {
    answers[a.stepId] = a.value;
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
  // A step can validly resolve to "no value" (e.g. scoreBand's "not sure") — Prisma's Json column
  // rejects a bare `undefined` (it must be an actual JSON value), so it needs the explicit
  // JsonNull sentinel instead, or upsert() throws and the whole request — including advancing
  // past this step — fails.
  const jsonValue = value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
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
