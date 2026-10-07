import type { FlowDefinition } from '../flow-engine/types';
import { homeLoanFlow } from './homeLoan';
import { personalLoanSteps } from './personalLoan';
import { goldLoanSteps } from './goldLoan';
import { businessLoanSteps } from './businessLoan';

/**
 * Composes the single ordered step array the engine walks (see flow-engine/engine.ts's forward-walk
 * design). homeLoan.ts itself is NOT edited for this beyond its 'product' step gaining three extra
 * options — everything else there (mobile/OTP, dedupe, PAN, email, pincode, segment, bureau/CIBIL
 * consent, loanType, income, property, result, etc.) is untouched, byte for byte.
 *
 * The full real identity chain (mobile+OTP+dedupe+PAN+email+segment+bureau consent) runs for EVERY
 * product, not just Home loan/LAP — "what are you looking for" (the 'product' step) only comes
 * after all of that, exactly where it always has. That means Personal/Gold/Business loan reach
 * ctx.answers.pan/name/segment/creditScore/mobile already populated for real by the time they
 * branch off (whether the customer was already known, via dedupeCheck's found branch, or brand new,
 * via the not-found branch's own PAN lookup + bureau pull) — see personalLoan.ts, which reuses
 * these directly instead of asking again. Only the product-specific questions and the final lead/
 * offers are DUMMY for these three (no confirmed Finfinity product code/API for them yet).
 *
 * Mechanically this is a plain splice right after 'product' — no relocation needed, since 'product'
 * already sits exactly where this design wants it (right before 'loanType'). Picking Home loan/Loan
 * against property continues straight into 'loanType' onward, unchanged; picking Personal/Gold/
 * Business loan is answered entirely within its own block and ends at its own terminal 'result'-type
 * step (done: true) long before the scan could ever reach 'loanType'.
 */
const productIndex = homeLoanFlow.steps.findIndex((s) => s.id === 'product');
if (productIndex === -1) throw new Error("flows/index.ts: homeLoanFlow has no 'product' step");

export const mainFlow: FlowDefinition = {
  id: 'multi_product_v1',
  steps: [
    ...homeLoanFlow.steps.slice(0, productIndex + 1),
    ...personalLoanSteps,
    ...goldLoanSteps,
    ...businessLoanSteps,
    ...homeLoanFlow.steps.slice(productIndex + 1),
  ],
};
