import Fastify from 'fastify';
import { evaluateEligibility } from './engine.js';
import type { ApplicantFacts, EligibilityCheckRequest, LenderCode } from './types.js';

const PORT = Number(process.env.PORT ?? 8096);
// Service-to-service auth only, same convention and same reasoning as pl-eligibility-precheck's
// server.ts — a separate shared secret, not the same one (never reuse a secret across two
// independent services). Unset in dev intentionally leaves this open, matching local PL behavior.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
// 2026-10-28: full build from HL_BRE.zip's real DMN data — keep this in sync with engine.ts's
// LENDER_DATA.
const VALID_LENDERS: LenderCode[] = [
  'ADITYA_BIRLA_HOUSING', 'AXIS_BANK_HL', 'BAJAJ_HOUSING_FINANCE', 'FEDERAL_BANK_HL',
  'HDFC_BANK_HL', 'ICICI_BANK_HL', 'ICICI_HFC', 'IDFC_FIRST_BANK_HL', 'IIFL_HL',
  'LT_HOUSING_FINANCE', 'PIRAMAL_HOUSING', 'PNB_HOUSING', 'RBL_BANK_HL', 'TATA_CAPITAL_HOUSING',
  'DBS_HL', 'KARUR_VYSYA_HL', 'HSBC_HL', 'JIO_CREDIT_LIMITED_HL', 'SBI_HL', 'BANK_OF_BARODA_HL',
  'AADHAR_HOUSING',
];
const REQUIRED_NUMBER_FIELDS = ['cibilScore', 'monthlyIncome', 'age', 'propertyValue', 'loanAmountRequested', 'tenureMonths'] as const;
const VALID_PROPERTY_TYPES = ['ready_to_move', 'under_construction', 'resale', 'plot_and_construction'];

function validateFacts(body: unknown): { ok: true; facts: ApplicantFacts; lenders?: LenderCode[] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Request body must be a JSON object.' };
  const { facts, lenders } = body as Partial<EligibilityCheckRequest>;
  if (typeof facts !== 'object' || facts === null) return { ok: false, error: '"facts" is required and must be an object.' };

  const f = facts as unknown as Record<string, unknown>;
  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (typeof f[field] !== 'number' || Number.isNaN(f[field])) {
      return { ok: false, error: `"facts.${field}" is required and must be a number.` };
    }
  }
  if (typeof f.employmentType !== 'string' || !['salaried', 'self_employed', 'business_owner'].includes(f.employmentType)) {
    return { ok: false, error: '"facts.employmentType" is required and must be one of: salaried, self_employed, business_owner.' };
  }
  if (typeof f.pincode !== 'string' || f.pincode.trim().length === 0) {
    return { ok: false, error: '"facts.pincode" is required and must be a non-empty string.' };
  }
  if (typeof f.propertyType !== 'string' || !VALID_PROPERTY_TYPES.includes(f.propertyType)) {
    return { ok: false, error: `"facts.propertyType" is required and must be one of: ${VALID_PROPERTY_TYPES.join(', ')}.` };
  }

  if (lenders !== undefined) {
    if (!Array.isArray(lenders) || lenders.some((l) => !VALID_LENDERS.includes(l as LenderCode))) {
      return {
        ok: false,
        error: VALID_LENDERS.length > 0
          ? `"lenders" must be an array containing only: ${VALID_LENDERS.join(', ')}.`
          : 'No Home Loan lenders are onboarded yet — this service has no evaluators wired in.',
      };
    }
  }

  return { ok: true, facts: facts as ApplicantFacts, lenders: lenders as LenderCode[] | undefined };
}

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/eligibility/home-loan', async (req, reply) => {
    if (INTERNAL_API_KEY && req.headers['x-internal-api-key'] !== INTERNAL_API_KEY) {
      reply.code(401);
      return { error: 'Missing or invalid x-internal-api-key header.' };
    }

    const validation = validateFacts(req.body);
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    return evaluateEligibility(validation.facts, validation.lenders);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
