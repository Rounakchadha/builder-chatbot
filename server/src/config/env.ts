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

  // Standalone Personal Loan eligibility pre-check (Poonawala Fincorp/Tata Capital/Unity SFB) —
  // see FINFINITY-BRE-MAIN/pl-eligibility-precheck. A SEPARATE service from everything else above;
  // unset keeps personalLoanEligibility.service.ts on the "always eligible" mock, same as every
  // other FINFINITY_* toggle in this file.
  PL_ELIGIBILITY_SERVICE_URL: z.string().optional().default(''),
  // Service-to-service shared secret for the above — sent as the x-internal-api-key header, never
  // the Finfinity OTP JWT (wrong audience/signer entirely; see that service's own server.ts
  // comment). Must match the precheck service's own INTERNAL_API_KEY exactly. Left unset, no
  // header is sent — fine only while the precheck service's own key is also unset (local dev).
  PL_ELIGIBILITY_API_KEY: z.string().optional().default(''),

  // Standalone Home Loan eligibility pre-check (21 real lenders) — see
  // FINFINITY-BRE-MAIN/hl-eligibility-precheck. A SEPARATE service from the PL one above (own
  // port 8096, own lender codes, own DMN data) — unset keeps homeLoanEligibility.service.ts on the
  // "always eligible" mock, same convention as every other FINFINITY_*/*_ELIGIBILITY_* toggle here.
  HL_ELIGIBILITY_SERVICE_URL: z.string().optional().default(''),
  // Service-to-service shared secret for the above — same convention as PL_ELIGIBILITY_API_KEY;
  // must match that service's own INTERNAL_API_KEY exactly. Left unset, no header is sent.
  HL_ELIGIBILITY_API_KEY: z.string().optional().default(''),
  // Finfinity's own real 5-call BRE chain for Personal Loan (create_anacity_lead ->
  // financerwiseeligibility -> setcorpamtten -> pl_financer_offer -> setbrefinanceroffertenure),
  // confirmed live end-to-end (2026-10-21) as a real alternative to the standalone pre-check
  // microservice above. Deliberately a SEPARATE flag, default OFF — direct instruction: "do not run
  // our bre yet. ill tell u when to switch between the two". Flipping this on later is the entire
  // intended switch; see personalLoanFinancer.service.ts.
  PL_REAL_FINANCER_CHAIN_ENABLED: zBoolEnv(),

  // RM summary email (2026-10-16) — sends the customer's contact details + selected product to
  // their assigned RM once a lead exists. Unset keeps email.service.ts on a log-only mock, same
  // convention as every other FINFINITY_*/PL_ELIGIBILITY_* toggle in this file: no real credentials
  // means no real send, not a crash.
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  // TEMPORARY test-only override (2026-10-21, same convention as FINFINITY_PAN_MOCK_OVERRIDE etc.):
  // every RM summary email goes to this address instead of the real RM's own email, so test sends
  // land somewhere the team can actually see them instead of a real (or fake fallback) RM's inbox.
  // Unset sends to the real rm.email as normal — remove this once real RM inboxes are the intended
  // recipient again.
  RM_EMAIL_OVERRIDE_TO: z.string().optional().default(''),
  // Gates every /admin/* route (see routes/admin.ts) — a plain shared-secret check (query param or
  // x-admin-token header), not full auth, since this is an internal-only reporting page. Empty in
  // development falls back to no auth at all (quick local iteration); empty anywhere else refuses
  // every /admin/* request outright rather than leaving it silently open (same fail-closed spirit
  // as assertProductionSafe below).
  ADMIN_TOKEN: z.string().optional().default(''),
  // Shared secret for the SDK launch-token handoff (see services/launchToken.service.ts) — a
  // partner's own backend (Finfinity's own app today; CIS or others later) encrypts a customer's
  // product/mobile/email with this exact secret to prove the data came from them, with NO API call
  // to us involved at all (2026-11-02 design — replaced an earlier issue-then-redeem endpoint that
  // added a network round-trip right when the customer clicked to open the chat). Left unset, every
  // partner effectively shares the same (empty-string-derived) key, which is fine for solo local
  // testing but means ANY two parties with that same default could decrypt each other's tokens — set
  // a real random value before handing this out to an actual partner.
  EXTERNAL_SDK_SECRET: z.string().optional().default(''),

  // A dedicated "always safe" test identity (2026-11-05) — for a Google Play reviewer (or anyone
  // else) to walk the full loan journey, including in production, without ever hitting a real
  // bureau pull or a real lender submission. A customer whose PAN/mobile matches these gets routed
  // to the mock PAN/bureau/OTP services regardless of the global FINFINITY_*_MOCK_OVERRIDE flags
  // (which apply to ALL traffic) — see config/sandbox.ts. Left unset, nothing changes for anyone.
  SANDBOX_TEST_PAN: z.string().optional().default(''),
  SANDBOX_TEST_MOBILE: z.string().optional().default(''),

  // CIS's own CRM webhook (2026-11-06, UAT values from Sai) — fired once per newly-created real
  // lead (see services/webhook.service.ts + lead.service.ts's ensureLeadOnce). Left unset, nothing
  // fires — safe no-op everywhere except where/when CIS's URL is actually configured.
  CIS_WEBHOOK_URL: z.string().optional().default(''),
  CIS_WEBHOOK_HMAC_SECRET: z.string().optional().default(''),
  CIS_WEBHOOK_BEARER_TOKEN: z.string().optional().default(''),

  // Where lib/logger.ts also writes a daily log file, in addition to stdout — see that file's own
  // comment. Left unset, defaults to ./logs (relative to the server process's cwd); in prod this
  // should point at a volume-backed path (see docker-compose.yml's `logs` volume) so it survives a
  // deploy recreating the container.
  LOG_DIR: z.string().optional().default(''),
});

export const env = EnvSchema.parse(process.env);

/** Security-review finding, 2026-10-23: nothing stopped this app from booting in production with
 * mocks, test overrides, or the placeholder secrets from .env.example still active — e.g. an empty
 * FINFINITY_API_BASE_URL silently swaps in MockSmsService, which accepts OTP "000000" for ANY
 * mobile number (see sms.service.ts), meaning anyone could "verify" as anyone else's number and see
 * their applications. Refuses to start at all if NODE_ENV=production and any of these are still
 * true — a real customer should never see a fake OTP gate, an invented CIBIL score, or a session
 * whose encryption key is the literal word "change-me". Every one of these failures means "you
 * forgot to configure this for production," not a code bug — fix the listed env var(s) and restart. */
function assertProductionSafe() {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!env.FINFINITY_API_BASE_URL) problems.push('FINFINITY_API_BASE_URL is empty — every real integration (OTP, dedupe, PAN, leads, status) would silently run on mocks instead, including an OTP mock that accepts "000000" for any number.');
  if (env.FINFINITY_BUREAU_MOCK_OVERRIDE) problems.push('FINFINITY_BUREAU_MOCK_OVERRIDE is true — customers would be shown an invented 680-850 CIBIL score, sent to the real Personal Loan lender engine as if genuine.');
  if (env.FINFINITY_PAN_MOCK_OVERRIDE) problems.push('FINFINITY_PAN_MOCK_OVERRIDE is true — PAN lookups would return fabricated names/DOB instead of the real getpandetail response.');
  if (!env.FINFINITY_OFFERS_ENABLED) problems.push('FINFINITY_OFFERS_ENABLED is false — Home Loan/LAP would show invented HDFC/ICICI/SBI-style offers instead of real getcustomeroffers data.');
  if (env.RM_EMAIL_OVERRIDE_TO) problems.push('RM_EMAIL_OVERRIDE_TO is set — every RM notification email would go to that test address instead of the customer\'s actual assigned RM.');
  if (env.SESSION_HMAC_SECRET.includes('change-me') || env.SESSION_HMAC_SECRET.includes('dev-only')) problems.push('SESSION_HMAC_SECRET still looks like the dev placeholder value — set a real random secret.');
  if (env.PII_ENCRYPTION_KEY.includes('change-me') || env.PII_ENCRYPTION_KEY.includes('dev-only')) problems.push('PII_ENCRYPTION_KEY still looks like the dev placeholder value — set a real random 32-byte key (customer PAN/mobile/DOB/email are encrypted with this; a known key makes that encryption pointless).');
  // Security-review finding, 2026-11-02: left unset (its default), EXTERNAL_SDK_SECRET derives to
  // the same key for every partner (see the field's own doc comment above) — any partner who
  // figured that out could mint a launch token claiming to be any other partner's customer.
  if (!env.EXTERNAL_SDK_SECRET) problems.push('EXTERNAL_SDK_SECRET is empty — every partner would share the same default-derived encryption key for SDK launch tokens, letting one partner forge another\'s.');
  if (problems.length) {
    // eslint-disable-next-line no-console -- startup-time fatal, before the real logger's transport is guaranteed ready
    console.error(`FATAL: refusing to start in production with unsafe configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
}

assertProductionSafe();

export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
