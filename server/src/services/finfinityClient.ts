import { Agent } from 'undici';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { reportFinfinityApiFailure } from './alerting.service';

// Node's global fetch pools/reuses keep-alive TCP connections by default. Over a long-running
// server process, a pooled connection to Finfinity's backend can go stale (silently dropped by
// their load balancer without a proper FIN/RST) — the NEXT request to reuse it then hangs until
// our own AbortSignal.timeout fires, even though a brand-new connection to the same endpoint at
// the same moment succeeds in well under a second (confirmed directly: a stuck server request
// timed out while a concurrent curl to the identical URL returned in ~87ms). A short
// keepAliveTimeout recycles idle sockets proactively, well before they can go stale, so this never
// shows up as a false "API is slow" to a customer.
const finfinityDispatcher = new Agent({ keepAliveTimeout: 4_000, keepAliveMaxTimeout: 4_000 });

/**
 * Every real Finfinity backend endpoint (searchcustomer, getpandetail, generateotpv2/
 * validateotpv2, generatebureau/validatebureau, create_anacity_lead, getcustomeroffers,
 * fetchstatusdata) lives on the SAME base URL and shares one response envelope — this is one
 * backend, not seven different vendors, so there's one client instead of one per service.
 *
 * Auth: there is no separate login/credential to configure. A successful OTP verify
 * (validateotpv2) — and again a successful bureau verify (validatebureau) — returns an
 * access/refresh token pair right in its own response. THAT token is what every other
 * authenticated call in the same conversation uses as `Authorization: Bearer <token>`; it's
 * per-conversation, not a shared server-wide secret. Callers pass it explicitly per request (see
 * `token` below) — see sms.service.ts/bureau.service.ts for where it's captured, and
 * flows/homeLoan.ts for where it's threaded through ctx.answers.finfinityAccessToken.
 */

export interface FinfinityEnvelope<T> {
  data: T;
  error_msg: string;
  error_code: string;
  error_dtl: unknown;
  activity: unknown;
}

export class FinfinityApiError extends Error {
  /** Set by throwTracked() below, after checking with alerting.service.ts whether this exact
   * endpoint+code combo is failing repeatedly right now — see that file's own doc comment. Mutable
   * (not constructor-set) so every existing call site that builds a FinfinityApiError directly
   * doesn't need touching; only the one place that actually throws it (requestOnce) sets this. */
  public isSystemic = false;

  constructor(
    message: string,
    public readonly code: string,
    public readonly detail: unknown,
  ) {
    super(message);
    this.name = 'FinfinityApiError';
  }
}

/** Every throw site in requestOnce goes through here instead of `throw new FinfinityApiError(...)`
 * directly — so every real Finfinity API failure, of any kind, gets tracked for the "is this a
 * repeating, systemic issue" check, with no risk of a future new failure path forgetting to call it. */
async function throwTracked(path: string, message: string, code: string, detail: unknown): Promise<never> {
  const err = new FinfinityApiError(message, code, detail);
  const { isSystemic } = await reportFinfinityApiFailure(path, code, message);
  err.isSystemic = isSystemic;
  throw err;
}

// Confirmed live against UAT: validateotpv2 returns error_code "CUST_NOT_EXIST" on its SUCCESS
// path (a brand-new customer was just created — the real data/tokens are right there in the
// envelope). generatebureau's CIBIL success path documents the same pattern with
// "CIBIL_QUESTION_QUEUE" (the question itself IS the successful next step, not a failure). Every
// other documented error_code corresponds to an actual failure — "empty string means success" is
// not a reliable rule for this API, so this is an explicit allowlist rather than a heuristic.
// Bug fixed 2026-11-22 (real prod customer, first real bureau pull ever run on prod): updatebureau
// — the endpoint we actually call now, not generatebureau — returns this exact SAME kind of
// success-flavored envelope, but under a DIFFERENT code than assumed here: "OTP_IDM_Email_Queue",
// not "CIBIL_QUESTION_QUEUE". The question/OTP challenge data was right there in the response (same
// as the CIBIL_QUESTION_QUEUE case), but this threw anyway since that exact string was never in the
// allowlist — blocking the bureau step outright with a generic "trouble reaching services" error.
// Bug fixed 2026-11-25, caught BEFORE it hit a real customer this time — Bitsflow's own confirmed
// error-code list for validatebureau's resendOTP:true path (yesterday's resend fix) returns
// "OTP_RESEND" on success ("OTP Resent Successfully") — the exact same success-flavored-error
// pattern as OTP_IDM_Email_Queue, just never added here when that resend code shipped.
// Bug fixed 2026-11-28 (real prod case, Tara Gupta's PAN, customer_id 52063) — a FOURTH instance of
// this exact pattern: "OTP_AlternateEmail_Entry_Queue" ("Please select the alternative mobile
// number") was being treated as a hard failure and handled by asking the customer for an alternate
// number (see homeLoan.ts's bureauAlternateNumberCorrection step) — but full-envelope logging
// added the same day to investigate it showed `data` carrying a complete, valid CIBIL
// questionKey/answerKey/ChallengeConfigGUID/otp_session_id session, identical in shape to a normal
// CIBIL_QUESTION_QUEUE success. Every "alternate number" retry was very likely generating a fresh
// valid session we were discarding every time, not genuinely failing — that's also why it
// "reproduced identically" on retry. The alternate-number-correction flow is kept as a fallback for
// if this code is ever genuinely returned with no usable data, but should rarely if ever trigger now.
const SUCCESS_FLAVORED_ERROR_CODES = new Set(['CUST_NOT_EXIST', 'CIBIL_QUESTION_QUEUE', 'OTP_IDM_Email_Queue', 'OTP_RESEND', 'OTP_AlternateEmail_Entry_Queue']);

// A hung real API call must never hang the whole conversation turn — but 10s was proving too
// tight for real Bitsflow endpoints (confirmed live, 2026-11-26: create_anacity_lead legitimately
// took >10s for a real LAS lead while every HL call that same day answered in 1-2s) — a slow-but-
// genuine response was being killed and shown to the customer as a failure. Raised to 25s, same
// ceiling already used for the widget's own client-side request timeout (widget/src/api.ts).
const REQUEST_TIMEOUT_MS = 25_000;

// One retry, after a short pause, and ONLY for failures where we genuinely never got a response
// back (a timeout, a dropped connection, or their server erroring at the HTTP level) — UAT has
// shown real, brief blips of exactly this kind (503s, slow responses) that a single retry would
// silently ride out instead of showing the customer an error for something that was never really
// their problem. Never retries a real business rejection (wrong OTP, invalid PAN, etc.) — those
// will just fail the same way again, and retrying only adds a pointless delay before the same
// answer.
const RETRY_DELAY_MS = 900;

function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof FinfinityApiError)) return false;
  return err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR' || err.code === 'BAD_RESPONSE' || /^HTTP_5\d\d$/.test(err.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Security-review finding, 2026-10-23: logger.ts's redact list only catches a fixed set of known
 * field names (pan/mobile/otp) — but `error_dtl`/`detail` is Finfinity's own free-form error body,
 * which can (and sometimes does) echo back whatever value we just submitted, under field names we
 * don't control and can't allowlist in advance. Every call site that logs this (see
 * businessLoan.service.ts, and the http-error/error-envelope branches below) only ever uses it for
 * diagnostics, never for actual logic, so it's safe to strip here at the source rather than trying
 * to redact it after the fact at every logging call site. */
function redactDetail(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  // Bumped 80->1000 chars, 2026-11-25 — too short to actually debug real failures with (today
  // alone: a duplicate-key constraint message and a "both bureaus failed" detail both got cut off
  // right where the useful part was). These logs stay on the server, access-controlled, not
  // customer-facing — still capped, just generously, not withheld-by-default short.
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}…[truncated]` : value;
  // Was a blanket withhold before — now logged too (size-capped, same reasoning as the string
  // case above: these are internal, access-controlled logs, and an object detail is exactly where
  // Bitsflow's real validation errors (field-by-field) tend to live.
  try {
    const json = JSON.stringify(value);
    return json.length > 1000 ? `${json.slice(0, 1000)}…[truncated]` : value;
  } catch {
    return '[object could not be serialized for logging]';
  }
}

async function requestOnce<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: { token?: string } | undefined, attempt: number): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;

  // Logged for every call so a real outage/slowdown is diagnosable from logs alone.
  // TEMPORARY, direct instruction 2026-11-26 ("write it in logs always... we'll remove it later"):
  // now also logs the full request body, to actually see what we're sending Bitsflow while chasing
  // their real errors. Deliberately never includes the bearer token itself (headers aren't logged
  // at all) — but body DOES now include PAN/mobile/DOB/income/etc. REMOVE requestBody once this
  // debugging push is done; this is a real step back from the 2026-10-23 security-review finding
  // that body logging is exactly where that PII lives.
  const startedAt = Date.now();
  logger.info({ event: 'finfinity_api_request', method, path, attempt, requestBody: body }, 'calling Finfinity API');

  let res: Response;
  try {
    res = await fetch(`${env.FINFINITY_API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // @ts-expect-error -- `dispatcher` is an undici/Node-fetch extension, not in the lib.dom.d.ts fetch() typing
      dispatcher: finfinityDispatcher,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    logger.error({ event: 'finfinity_api_network_error', path, attempt, timedOut, durationMs: Date.now() - startedAt }, 'Finfinity API request failed before a response came back');
    return throwTracked(path, timedOut ? 'Finfinity API timed out' : 'Could not reach Finfinity API', timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', err);
  }

  let envelope: FinfinityEnvelope<T>;
  try {
    envelope = (await res.json()) as FinfinityEnvelope<T>;
  } catch (err) {
    logger.error({ event: 'finfinity_api_bad_response', path, attempt, httpStatus: res.status, durationMs: Date.now() - startedAt }, 'Finfinity API returned a non-JSON response');
    return throwTracked(path, `Finfinity API returned a non-JSON response (HTTP ${res.status})`, 'BAD_RESPONSE', err);
  }

  // Confirmed live: a rejected/missing bearer token doesn't come back as the usual envelope at
  // all — it's Django REST Framework's own generic {"detail": "..."} shape, with no error_code
  // field. Checking error_code alone let this through as a false "success" with envelope.data
  // undefined, which then crashed every caller expecting an array to index into. A non-2xx HTTP
  // status is always a real failure regardless of what shape the body happens to be in.
  if (!res.ok) {
    const detail = (envelope as unknown as { detail?: string })?.detail;
    // Security-review finding, 2026-10-23: there's no refresh-token call anywhere against this
    // backend yet (no endpoint for it is documented in this codebase, and inventing one without
    // confirming it with Finfinity would be guessing) — so an expired access token just failed here
    // with the same totally generic message as every other error, leaving the customer stuck with
    // no idea what actually went wrong or that starting over would fix it. This at least tells them
    // the truth instead of a blank "something went wrong."
    const message = res.status === 401 ? 'Your session needs to be refreshed — please restart your application.' : detail || envelope.error_msg || `Finfinity API error (HTTP ${res.status})`;
    // Bug fixed 2026-11-16: this only ever logged the generic DRF `detail` field — Bitsflow's own
    // envelope shape (error_msg/error_code, e.g. "OTP_EXPIRED") was never captured here at all, so
    // a real non-2xx failure (like a customer's OTP attempt) left nothing in the logs to say WHY it
    // failed, only the bare HTTP status. Same gap as the CIS webhook's response-body logging, fixed
    // the same day for the same reason — found while trying to debug a real "incorrect OTP" report.
    logger.warn({ event: 'finfinity_api_http_error', path, attempt, httpStatus: res.status, detail, errorMsg: envelope.error_msg, errorCode: envelope.error_code, durationMs: Date.now() - startedAt }, 'Finfinity API returned a non-2xx status');
    return throwTracked(path, message, envelope.error_code || `HTTP_${res.status}`, redactDetail(envelope.error_dtl));
  }

  if (envelope.error_code && !SUCCESS_FLAVORED_ERROR_CODES.has(envelope.error_code)) {
    // TEMPORARY, 2026-11-27 — checking whether OTP_AlternateEmail_Entry_Queue (and any other error
    // code like it) actually carries candidate data (e.g. a list of alternate mobile numbers)
    // alongside the error_code, which this log line never surfaced before — only error_msg/code/dtl
    // were ever logged on this branch, so envelope.data/error_dtl's full shape was silently dropped
    // every time. REMOVE once we know either way for OTP_AlternateEmail_Entry_Queue.
    logger.warn(
      { event: 'finfinity_api_error', path, attempt, code: envelope.error_code, msg: envelope.error_msg, rawEnvelope: envelope, durationMs: Date.now() - startedAt },
      'Finfinity API returned an error envelope',
    );
    return throwTracked(path, envelope.error_msg || 'Finfinity API error', envelope.error_code, redactDetail(envelope.error_dtl));
  }

  // TEMPORARY, same 2026-11-26 instruction as requestBody above — full response data now logged on
  // success too, not just the fact that it succeeded. REMOVE responseData once done debugging.
  logger.info({ event: 'finfinity_api_success', path, attempt, durationMs: Date.now() - startedAt, responseData: envelope.data }, 'Finfinity API call succeeded');
  return envelope.data;
}

// Guardrail added 2026-11-27: a step being resent (a flaky client retrying, a test script looping,
// or any future bug like it) re-runs that step's onAnswer from scratch, which fires a brand-new
// REAL call here every time — the retry logic above only covers ONE internal retry per top-level
// call, it does nothing to stop the outside world from calling `request()` again and again. Found
// live the hard way: a bad test script fired /leadflow/updatebureau ~60+ times in under a minute
// for one customer, every one a real bureau-pull attempt, before our own circuit breaker kicked in.
// Real bureau pulls cost real money per attempt (see feedback_bureau_api_costs_money) — this is the
// one class of endpoint where "just let it retry, Bitsflow is the one being rate-limited" isn't
// good enough. Scoped ONLY to the bureau-pull endpoints, not every Finfinity call, since those are
// the ones that cost money per attempt; a short in-memory cooldown keyed by whatever customer
// identifier is in the request body is enough to stop a storm without affecting a normal flow
// (which only ever calls one of these once per bureau attempt anyway).
const BUREAU_COST_SENSITIVE_PATHS = new Set(['/leadflow/generatebureau', '/leadflow/updatebureau', '/leadflow/validatebureau', '/leadflow/fetchbureaudata']);
const BUREAU_CALL_COOLDOWN_MS = 5_000;
const lastBureauCallAt = new Map<string, number>();

// Bug found 2026-11-27 (real prod case, Tara Gupta): the cooldown above set its own timestamp on
// the FIRST call, then blocked the deliberate, code-controlled second call that
// generateBureauWithExperianFallback (homeLoan.ts) makes a split-second later to retry CIBIL as
// Experian — so the cooldown meant for blocking a genuine external retry storm was blocking our
// own one-shot internal fallback instead, and the customer never got the Experian retry they were
// supposed to. `skipBureauCooldown` lets that one specific, already-bounded-to-exactly-one-retry
// call bypass the check; every other caller still goes through the cooldown as before.
function bureauCooldownKey(path: string, body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const identifier = b.customer_id ?? b.phone_number ?? b.pan;
  if (identifier === undefined) return undefined;
  return `${path}:${String(identifier)}`;
}

function checkBureauCooldown(path: string, body: unknown, skip?: boolean): void {
  if (skip || !BUREAU_COST_SENSITIVE_PATHS.has(path)) return;
  const key = bureauCooldownKey(path, body);
  if (!key) return;
  const last = lastBureauCallAt.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < BUREAU_CALL_COOLDOWN_MS) {
    logger.warn({ event: 'finfinity_bureau_cooldown_blocked', path, key }, 'Blocked a bureau-pull call — same customer retried within the local cooldown window, real call skipped to avoid a paid-API retry storm');
    throw new FinfinityApiError('A credit bureau check was just requested for this customer — please wait a few seconds before trying again.', 'LOCAL_COOLDOWN', { path });
  }
  lastBureauCallAt.set(key, now);
}

// Security-review finding, 2026-10-23: nothing capped how many calls to Finfinity could be in
// flight at once — if their backend ever slowed down, every simultaneous customer conversation
// could pile up waiting on it at the same time, with nothing to throttle or fail fast, tying up
// this server's own request-handling capacity along with it. A simple counting semaphore (no new
// dependency needed) caps concurrent outbound calls; anything over the cap queues instead of firing
// immediately. 20 is generous for this app's real traffic today while still bounding the worst case.
const MAX_CONCURRENT_FINFINITY_CALLS = 20;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_FINFINITY_CALLS) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts?: { token?: string; retryOnTransient?: boolean; skipBureauCooldown?: boolean },
): Promise<T> {
  checkBureauCooldown(path, body, opts?.skipBureauCooldown);
  await acquireSlot();
  try {
    try {
      return await requestOnce<T>(method, path, body, opts, 1);
    } catch (err) {
      if (opts?.retryOnTransient === false || !isTransientFailure(err)) throw err;
      logger.warn({ event: 'finfinity_api_retry', path }, 'transient failure — retrying once after a short pause');
      await sleep(RETRY_DELAY_MS);
      return await requestOnce<T>(method, path, body, opts, 2);
    }
  } finally {
    releaseSlot();
  }
}

export const finfinityClient = {
  // retryOnTransient defaults to true: safe because every real call site is either read-only
  // (searchcustomer/getpandetail/getcustomeroffers/fetchstatusdata) or setting a field to a value
  // that's harmless to set twice (updatelead/updatecustomerv3). The few calls that are NOT safe to
  // repeat blind (they create/consume something real: generateotpv2/validateotpv2's SMS send and
  // attempt count, create_anacity_lead's new lead row, generatebureau/validatebureau's OTP
  // session) explicitly pass `retryOnTransient: false` at their call sites.
  post: <T>(path: string, body: unknown, opts?: { token?: string; retryOnTransient?: boolean; skipBureauCooldown?: boolean }) =>
    request<T>('POST', path, body, opts),
  get: <T>(path: string, opts?: { token?: string; retryOnTransient?: boolean }) => request<T>('GET', path, undefined, opts),
};
