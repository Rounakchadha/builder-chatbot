import type { ChatTurnResponse } from '@builder-chatbot/shared';
import type { FlowDefinition, StepContext, StepDefinition } from './types';

/** Ports the prototype's applicablePath()/nextStepId() logic, generalized to any FlowDefinition. */
export function applicablePath(flow: FlowDefinition, ctx: StepContext): StepDefinition[] {
  return flow.steps.filter((s) => (s.isApplicable ? s.isApplicable(ctx) : true));
}

export function getStep(flow: FlowDefinition, stepId: string): StepDefinition {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step "${stepId}" in flow "${flow.id}"`);
  return step;
}

/**
 * Walks forward from currentId's position in the flow's full step array (not the filtered
 * applicable path) so a step whose own isApplicable depends on the answer it *just* collected
 * (e.g. "isApplicable: !ctx.answers.email") doesn't strand itself: right after being answered, it
 * would no longer appear in applicablePath(ctx) at all, so locating it there would silently return
 * -1 and (via path[-1 + 1] === path[0]) restart the whole flow from the first step.
 */
export function nextStepId(flow: FlowDefinition, currentId: string, ctx: StepContext): string | null {
  const idx = flow.steps.findIndex((s) => s.id === currentId);
  for (let i = idx + 1; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!step.isApplicable || step.isApplicable(ctx)) return step.id;
  }
  return null;
}

export function firstStepId(flow: FlowDefinition, ctx: StepContext): string {
  const path = applicablePath(flow, ctx);
  if (path.length === 0) throw new Error(`Flow "${flow.id}" has no applicable steps`);
  return path[0].id;
}

export function renderStep(flow: FlowDefinition, stepId: string, sessionToken: string, ctx: StepContext, errorText?: string): ChatTurnResponse {
  const step = getStep(flow, stepId);
  const path = applicablePath(flow, ctx);
  const stepNumber = path.findIndex((s) => s.id === stepId) + 1;

  return {
    sessionToken,
    stepId: step.id,
    botMessage: step.botMessage(ctx),
    hint: step.hint?.(ctx) ?? null,
    input: step.input(ctx),
    progress: {
      stepNumber: Math.max(stepNumber, 1),
      totalSteps: path.length,
      label: step.progressLabel,
    },
    loading: step.type === 'apiFetch' || step.type === 'result',
    done: step.type === 'result',
    errorText: errorText ?? null,
  };
}
