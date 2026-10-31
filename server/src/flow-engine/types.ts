import type { InputSpec, StepType } from '@builder-chatbot/shared';

export type Answers = Record<string, unknown>;

export interface ValidationResult {
  ok: boolean;
  parsed?: unknown;
  error?: string;
}

export interface StepContext {
  answers: Answers;
  conversationId: string;
  meta: { ip: string; userAgent?: string };
}

/** Extra keys an onAnswer handler wants merged into ctx.answers and persisted alongside the step's own value. */
export type OnAnswerResult = Record<string, unknown> | void;

/**
 * One node in a flow. Flow configs (see /flows) are pure data + small
 * template functions — the engine below is generic across every future
 * product, so adding "personal loan" later means writing a new flow config,
 * not touching engine.ts.
 */
export interface StepDefinition {
  id: string;
  type: StepType;
  /** Defaults to always applicable. Used for branching (e.g. skip property questions for LAP-on-owned-property). */
  isApplicable?: (ctx: StepContext) => boolean;
  botMessage: (ctx: StepContext) => string | null;
  /** Short form of the question, used to re-anchor the conversation after a greeting/off-topic/
   * domain-question detour (e.g. "hi" mid-flow) — falls back to botMessage(ctx) when a step's
   * botMessage is already just the bare question (true for everything except 'mobile', which
   * leads with a long intro that shouldn't be repeated every time someone says hello). */
  restatement?: (ctx: StepContext) => string | null;
  hint?: (ctx: StepContext) => string | undefined;
  input: (ctx: StepContext) => InputSpec;
  /** Validates the raw string the widget sent (button value, number field, OTP digits, etc). */
  validate?: (value: string | undefined, ctx: StepContext) => ValidationResult;
  /** Side effects on a valid answer: send OTP, call CIBIL, persist, etc. May throw an Error whose message is shown as errorText (stays on this step). */
  onAnswer?: (parsed: unknown, ctx: StepContext) => Promise<OnAnswerResult> | OnAnswerResult;
  progressLabel: string;
  /** apiFetch/message steps with no user input auto-advance after the widget shows the message. */
  autoAdvance?: boolean;
}

export interface FlowDefinition {
  id: string; // e.g. "home_loan_v1"
  steps: StepDefinition[];
}
