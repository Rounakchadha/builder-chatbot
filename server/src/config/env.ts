import 'dotenv/config';
import { z } from 'zod';

// `z.coerce.boolean()` calls JS's `Boolean(value)` — since env vars always arrive as strings, and
// EVERY non-empty string (including the literal text "false") is truthy in JS, writing
// `SOME_FLAG=false` in a .env file never actually turns it off; only leaving it unset does.
// Confirmed live (2026-09-23): this silently kept FINFINITY_PAN_MOCK_OVERRIDE=false being read as
// true. This parses the literal strings instead, so "false"/"0" behave the way anyone would expect.
const zBoolEnv = (defaultValue: 'true' | 'false' = 'false') =>
  z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v) => v.trim().toLowerCase() === 'true' || v.trim() === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Fastify's trustProxy makes it read the caller's IP from the X-Forwarded-For header instead of
  // the actual TCP connection — correct (and necessary for rate limiting to work at all) once a
  // real reverse proxy/load balancer sits in front and controls that header, but a serious hole
  // when the app is reachable directly: any caller can put whatever IP they like in that header
  // and get a fresh rate-limit bucket on every request. Defaults to false (direct exposure, our
  // current deployment); set true only once there's an actual trusted proxy in front.
  TRUST_PROXY: zBoolEnv(),

  SESSION_HMAC_SECRET: z.string().min(16, 'SESSION_HMAC_SECRET must be at least 16 chars'),
  PII_ENCRYPTION_KEY: z.string().min(32, 'PII_ENCRYPTION_KEY must be at least 32 chars (AES-256 key material)'),

  // One backend serves every real integration point (dedupe, PAN lookup, OTP, bureau,
  // lead creation, lender offers, status) — see server/src/services/finfinityClient.ts.
  // UAT  : https://backend.uatfinfinity.in/api/v1
  // Prod : https://bev3.finfinity.co.in/api/v1
  FINFINITY_API_BASE_URL: z.string().optional().default(''),
  // getcustomeroffers needs an already-created lead (leadid), which means eligibility/lender
  // offers can only go live for real once the flow creates the lead BEFORE computing eligibility
  // instead of after — a deliberate reordering, not just a service swap. Keep this off
  // independently of FINFINITY_API_BASE_URL until that reorder is designed and built.
  FINFINITY_OFFERS_ENABLED: zBoolEnv(),
  // TEMPORARY test-only escape hatch (2026-09-23): the real getpandetail endpoint on UAT is
  // rejecting every PAN tried so far, including a genuine real one — confirmed not our bug (tested
  // with curl directly, bypassing this app entirely). Set true to keep PAN lookup on the mock while
  // everything else (OTP, dedupe, lead creation, offers) stays on the real UAT backend, so the rest
  // of the journey can still be tested end-to-end. Remove once the dev team fixes/confirms this
  // endpoint — see pan.service.ts.
  FINFINITY_PAN_MOCK_OVERRIDE: zBoolEnv(),
  // Same idea as FINFINITY_PAN_MOCK_OVERRIDE: RealBureauService.pull() is deliberately
  // unimplemented (see bureau.service.ts) since the real bureau check needs its own interactive
  // step (a CIBIL question or an Experian OTP) that doesn't exist in the flow yet. Defaults to
  // true (mock) — unlike the other overrides — specifically so that forgetting to set this var on
  // a real-backend deploy fails safe into the working mock path instead of into RealBureauService,
  // which throws on every single call and would otherwise break eligibility checks for everyone.
  // Set to false only once RealBureauService.pull() actually exists.
  FINFINITY_BUREAU_MOCK_OVERRIDE: zBoolEnv('true'),
});

export const env = EnvSchema.parse(process.env);

export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
