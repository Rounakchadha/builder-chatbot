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
const SUCCESS_FLAVORED_ERROR_CODES = new Set(['CUST_NOT_EXIST', 'CIBIL_QUESTION_QUEUE']);

// A hung real API call must never hang the whole conversation turn — 10s is generous enough for
// any of these endpoints while still failing fast enough that the customer gets a "try again"
// instead of an endlessly spinning chat.
const REQUEST_TIMEOUT_MS = 10_000;

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
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…[truncated]` : value;
  return '[object withheld from logs — Finfinity error detail payloads can echo back submitted values]';
}

async function requestOnce<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: { token?: string } | undefined, attempt: number): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;

  // Logged for every call so a real outage/slowdown is diagnosable from logs alone — deliberately
  // never includes the request body (or the token itself), which is exactly where a
  // PAN/mobile/OTP/DOB/access-token would be.
  const startedAt = Date.now();
  logger.info({ event: 'finfinity_api_request', method, path, attempt }, 'calling Finfinity API');

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
    logger.warn({ event: 'finfinity_api_http_error', path, attempt, httpStatus: res.status, detail, durationMs: Date.now() - startedAt }, 'Finfinity API returned a non-2xx status');
    return throwTracked(path, message, envelope.error_code || `HTTP_${res.status}`, redactDetail(envelope.error_dtl));
  }

  if (envelope.error_code && !SUCCESS_FLAVORED_ERROR_CODES.has(envelope.error_code)) {
    logger.warn({ event: 'finfinity_api_error', path, attempt, code: envelope.error_code, msg: envelope.error_msg, durationMs: Date.now() - startedAt }, 'Finfinity API returned an error envelope');
    return throwTracked(path, envelope.error_msg || 'Finfinity API error', envelope.error_code, redactDetail(envelope.error_dtl));
  }

  logger.info({ event: 'finfinity_api_success', path, attempt, durationMs: Date.now() - startedAt }, 'Finfinity API call succeeded');
  return envelope.data;
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
  opts?: { token?: string; retryOnTransient?: boolean },
): Promise<T> {
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
  post: <T>(path: string, body: unknown, opts?: { token?: string; retryOnTransient?: boolean }) => request<T>('POST', path, body, opts),
  get: <T>(path: string, opts?: { token?: string; retryOnTransient?: boolean }) => request<T>('GET', path, undefined, opts),
};
