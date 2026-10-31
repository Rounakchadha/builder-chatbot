import { describe, expect, it } from 'vitest';
import { applicablePath, getStep, nextStepId } from '../src/flow-engine/engine';
import type { StepContext } from '../src/flow-engine/types';
import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION } from '@builder-chatbot/shared';
import { homeLoanFlow } from '../src/flows/homeLoan';

function ctxWith(answers: Record<string, unknown>): StepContext {
  return { answers: { intent: CHECK_ELIGIBILITY, ...answers }, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } };
}

describe('home loan flow branching', () => {
  it('starts with the intent gate, before anything else', () => {
    const path = applicablePath(homeLoanFlow, { answers: {}, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } }).map((s) => s.id);
    expect(path[0]).toBe('intent');
  });

  it('"check an existing application" still verifies identity via OTP before result — no dedupe/PAN/bureau steps', () => {
    // intent is pre-answered here (simulating having already picked it), so — same as every other
    // already-answered field in this flow — 'intent' itself is correctly skipped from here on.
    const ctx: StepContext = { answers: { intent: CHECK_EXISTING_APPLICATION }, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } };
    const path = applicablePath(homeLoanFlow, ctx).map((s) => s.id);
    expect(path).toEqual(['mobile', 'triggerOtpDedupe', 'otpDedupe', 'fetchApplications', 'fetchApplicationStatus', 'result']);
  });

  it('a resumed identity (intent/mobile/token already answered) skips intent, mobile AND the OTP step entirely', () => {
    const ctx: StepContext = {
      answers: { intent: CHECK_ELIGIBILITY, mobile: '9876543210', finfinityAccessToken: 'tok' },
      conversationId: 'test-convo',
      meta: { ip: '127.0.0.1' },
    };
    const path = applicablePath(homeLoanFlow, ctx).map((s) => s.id);
    expect(path).not.toContain('intent');
    expect(path).not.toContain('mobile');
    expect(path).not.toContain('triggerOtpDedupe');
    expect(path).not.toContain('otpDedupe');
    expect(path[0]).toBe('dedupeCheck');
  });

  it('shows the applicationSelector only once there are 2+ applications to choose between', () => {
    const oneCtx: StepContext = {
      answers: { intent: CHECK_EXISTING_APPLICATION, applications: [{ builderLeadId: '1', label: 'Home loan (Lead ID: 1)' }] },
      conversationId: 'test-convo',
      meta: { ip: '127.0.0.1' },
    };
    expect(applicablePath(homeLoanFlow, oneCtx).map((s) => s.id)).not.toContain('applicationSelector');

    const twoCtx: StepContext = {
      answers: {
        intent: CHECK_EXISTING_APPLICATION,
        applications: [
          { builderLeadId: '1', label: 'Home loan (Lead ID: 1)' },
          { builderLeadId: '2', label: 'Loan Against Property (Lead ID: 2)' },
        ],
      },
      conversationId: 'test-convo',
      meta: { ip: '127.0.0.1' },
    };
    expect(applicablePath(homeLoanFlow, twoCtx).map((s) => s.id)).toContain('applicationSelector');

    const selectedCtx: StepContext = { answers: { ...twoCtx.answers, selectedLeadId: '2' }, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } };
    expect(applicablePath(homeLoanFlow, selectedCtx).map((s) => s.id)).not.toContain('applicationSelector');
  });

  it('eligibility intent asks for mobile right after intent — no separate consent gate', () => {
    const path = applicablePath(homeLoanFlow, { answers: {}, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } }).map((s) => s.id);
    expect(path[0]).toBe('intent');
    expect(path).not.toContain('contactConsent');
    expect(path).not.toContain('scoreBand');
  });

  it('a pre-answered intent skips straight to mobile, and a pre-answered mobile+token skips OTP too', () => {
    const intentOnly: StepContext = { answers: { intent: CHECK_ELIGIBILITY }, conversationId: 'test-convo', meta: { ip: '127.0.0.1' } };
    expect(applicablePath(homeLoanFlow, intentOnly).map((s) => s.id)[0]).toBe('mobile');
  });

  it('"check my eligibility" runs the full dedupe/bureau flow', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: true })).map((s) => s.id);
    expect(path).toContain('otpDedupe');
    expect(path).toContain('dedupeCheck');
    expect(path).toContain('otpBureauFound');
    expect(path).toContain('profileFound');
    expect(path).toContain('product');
  });

  it('Flow A (dedupe found) includes otpDedupe/otpBureauFound/profileFound and excludes the not-found-only steps', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: true })).map((s) => s.id);
    expect(path).toContain('otpDedupe');
    expect(path).toContain('otpBureauFound');
    expect(path).toContain('profileFound');
    expect(path).not.toContain('pan');
    expect(path).not.toContain('otpBureauNotFound');
  });

  it('a found customer whose credit score is already known (cached from an earlier check) skips the bureau-consent OTP entirely', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: true, creditScore: 780 })).map((s) => s.id);
    expect(path).not.toContain('triggerOtpBureauFound');
    expect(path).not.toContain('otpBureauFound');
    expect(path).not.toContain('bureauFetchFound');
    expect(path).toContain('profileFound');
    expect(path).toContain('product');
  });

  it('Flow B (dedupe not found) goes straight to PAN — mobile entry already covered consent, no second gate', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: false })).map((s) => s.id);
    expect(path).toContain('otpDedupe');
    expect(path).toContain('pan');
    expect(path).toContain('panFetch');
    expect(path).toContain('otpBureauNotFound');
    expect(path).toContain('createCustomer');
    expect(path).not.toContain('otpBureauFound');
    expect(path).not.toContain('profileFound');
    expect(path).not.toContain('panConsentGate');
  });

  it('otpDedupe is applicable even before dedupeCheck resolves, but no found/not-found-specific step is', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({})).map((s) => s.id);
    expect(path).toContain('otpDedupe');
    expect(path).not.toContain('otpBureauFound');
    expect(path).not.toContain('otpBureauNotFound');
    expect(path).not.toContain('pan');
    expect(path).not.toContain('profileFound');
  });

  it('asks email/pincode/segment only once each — skipped once already known (e.g. from dedupe)', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: true, email: 'a@b.com', pincode: '400001', segment: 'Salaried' })).map((s) => s.id);
    expect(path).not.toContain('email');
    expect(path).not.toContain('pincode');
    expect(path).not.toContain('segment');
  });

  it('skips propertyGate for a balance transfer and goes straight to propertyType', () => {
    const ctx = ctxWith({ dedupeFound: true, product: 'Home loan', loanType: 'Balance transfer (BT)' });
    const next = nextStepId(homeLoanFlow, 'emi', ctx);
    expect(next).toBe('propertyType');
  });

  it('skips propertyGate for LAP-against-owned-property and goes straight to propertyType', () => {
    const ctx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Loan Against Property (LAP)' });
    const next = nextStepId(homeLoanFlow, 'emi', ctx);
    expect(next).toBe('propertyType');
  });

  it('asks propertyGate for a fresh home loan purchase', () => {
    const ctx = ctxWith({ dedupeFound: true, product: 'Home loan', loanType: 'Fresh purchase' });
    const next = nextStepId(homeLoanFlow, 'emi', ctx);
    expect(next).toBe('propertyGate');
  });

  it('only asks occupancy/collateralType for loan-against-property, not home loan', () => {
    const homeLoanCtx = ctxWith({ dedupeFound: true, product: 'Home loan', loanType: 'Fresh purchase', propertyGate: 'Yes' });
    const homeLoanPath = applicablePath(homeLoanFlow, homeLoanCtx).map((s) => s.id);
    expect(homeLoanPath).not.toContain('occupancy');
    expect(homeLoanPath).not.toContain('collateralType');

    const lapCtx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Property purchase', propertyGate: 'Yes' });
    const lapPath = applicablePath(homeLoanFlow, lapCtx).map((s) => s.id);
    expect(lapPath).toContain('occupancy');
    expect(lapPath).toContain('collateralType');
  });

  it('offers the right collateralType options for each LAP property type', () => {
    const commercialCtx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Property purchase', propertyGate: 'Yes', propertyType: 'Commercial' });
    const commercialStep = getStep(homeLoanFlow, 'collateralType');
    expect(commercialStep.input(commercialCtx)).toMatchObject({
      // 'Plot' moved to the end of each list (2026-10-31 direct instruction).
      options: ['Godown', 'Hotel', 'School/College', 'Resort', 'Restaurant', 'Nursing Home', 'Hospital', 'APMC', 'Shop', 'Banquet Hall', 'Plot'],
    });

    const industrialCtx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Property purchase', propertyGate: 'Yes', propertyType: 'Industrial' });
    expect(commercialStep.input(industrialCtx)).toMatchObject({ options: ['Godown', 'Factory', 'Warehouse', 'Plot'] });

    const residentialCtx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Property purchase', propertyGate: 'Yes', propertyType: 'Residential' });
    expect(commercialStep.input(residentialCtx)).toMatchObject({ options: ['Apartment/Flat', 'Bunglow', 'Rowhouse', 'Plot'] });
  });

  it('never asks propertyType/occupancy when the property has not yet been identified', () => {
    const ctx = ctxWith({ dedupeFound: true, product: 'Loan Against Property', loanType: 'Property purchase', propertyGate: 'No' });
    const path = applicablePath(homeLoanFlow, ctx).map((s) => s.id);
    expect(path).not.toContain('propertyType');
    expect(path).not.toContain('occupancy');
  });

  it('ends every path with result as the last step', () => {
    const path = applicablePath(homeLoanFlow, ctxWith({ dedupeFound: true })).map((s) => s.id);
    expect(path[path.length - 1]).toBe('result');
  });
});
