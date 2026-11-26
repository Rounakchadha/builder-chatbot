import { ChatTurnResponse, type ChatMessageRequest } from '@builder-chatbot/shared';

export class SessionExpiredError extends Error {}

/** Security-review finding, 2026-10-23: every fetch call used to parse `res.json()` unconditionally,
 * even on a non-2xx response — a 429/500/etc. body got read as if it were a success payload, so the
 * caller never learned the request actually failed (a button like "Submit"/"Select this offer" just
 * stayed stuck on "Selecting…" forever). `status` is carried along so callers can tell a rate limit
 * (429) apart from any other failure and show a more specific message. */
export class ApiError extends Error {
  constructor(public status: number, message?: string) {
    super(message ?? `Request failed (${status})`);
  }
}

// Bumped 15s -> 25s, 2026-11-25: real UAT case (Sparsh's test) showed the widget's own generic
// "something went wrong" fatal error even though the server was still working correctly — a chat
// step that internally hits getcustomeroffers (10s timeout + one retry = ~20-22s worst case, already
// handled server-side as a graceful "no offers" result) took longer than this client timeout, so the
// browser aborted the request before the server's own valid response ever arrived.
//
// Bumped 25s -> 90s, 2026-11-26: the server's own per-call Finfinity timeout (finfinityClient.ts's
// REQUEST_TIMEOUT_MS) was separately raised 10s -> 25s the same day — real Bitsflow endpoints were
// genuinely taking longer than 10s to respond (confirmed live), not actually failing. That alone
// made the old 25s client timeout stale, but the bigger miss: the 'result' step's single request
// can chain MULTIPLE real Finfinity calls sequentially, not just one — confirmed live the same day
// (Sparsh's own real test): create_anacity_lead (two instant 502s, then a 22s success) immediately
// followed by getcustomeroffers (11.3s) totalled ~34s in one customer-facing turn, already past the
// old 25s client timeout, even though nothing had actually failed — the backend finished seconds
// later anyway (lead created, real offers computed, CIS webhook sent). 90s gives real headroom for
// that same chain even if one of those calls needs its own full 25s-timeout-then-retry cycle.
const DEFAULT_TIMEOUT_MS = 90_000;

async function postJson<T>(url: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error && err.name === 'AbortError' ? 'Request timed out' : 'Network error');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Bug fixed 2026-11-25 (real customer report, Sparsh's own test: "couldn't select this offer"
    // showed a generic message even though the server had a specific, actionable one — "your session
    // needs to be refreshed, please restart" — ready to show). This used to always synthesize a
    // generic "Request failed (status)" message without ever reading the response body, so no
    // server-provided message — several endpoints already send one as `message`, a few older ones
    // as `error` — ever reached the caller. Body read is best-effort; a non-JSON or unparseable body
    // still falls back to the generic message exactly as before.
    let serverMessage: string | undefined;
    try {
      const body = (await res.json()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') serverMessage = body.message;
      else if (typeof body.error === 'string' && body.error.includes(' ')) serverMessage = body.error;
    } catch {
      // not JSON, or already consumed — fall through to the generic message below
    }
    throw new ApiError(res.status, serverMessage ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export class ChatApi {
  constructor(private baseUrl: string) {}

  async goldSubmit(sessionToken: string): Promise<{ ok: boolean; alreadyExists?: boolean; message?: string; leadId?: string; rm?: { name: string; phone: string; email: string } }> {
    return postJson(`${this.baseUrl}/api/chat/gold-submit`, { sessionToken });
  }

  async selectOffer(sessionToken: string, lenderName: string): Promise<{ ok: boolean; error?: string; leadId?: string; rm?: { name: string; phone: string; email: string } }> {
    // Bug fixed 2026-11-19 (real customer report: the server actually completed the selection
    // successfully — 200 OK, real RM returned — a fraction of a second AFTER this call's own
    // timeout fired, showing a false "couldn't select" error). Root cause: the underlying Finfinity
    // call (setbrefinanceroffertenure) retries once on a transient failure, each attempt capped at
    // the server's own timeout — originally 10s, so 10s + a ~1s pause + another 10s was a real,
    // legitimate ~21s worst case, well past the generic 15s default every other call here uses.
    //
    // Extended 2026-11-20 (direct instruction: don't surface a "please retry" error on a slow-but-
    // still-working request — silently wait longer and retry once ourselves). 20s already covered
    // that ~21s worst case almost every time; on the rare case it's still not enough, this retries
    // once more automatically, with no visible change to the customer (the button just keeps
    // reading "Selecting…" the whole time) — a real error only ever shows if BOTH attempts fail.
    // Safe to retry blindly: unlike lead creation, this just re-sets the same tenure on the same
    // lead (setOfferTenure)/re-runs ensureLeadOnce (already dedupes), so a retry can't double-submit.
    //
    // Bumped 20s -> 50s, 2026-11-26, same day and same reason as DEFAULT_TIMEOUT_MS above: the
    // server's own Finfinity timeout moved 10s -> 25s, so the single-attempt worst case (one real
    // call + one server-side retry) moved from ~21s to ~51s accordingly.
    const ATTEMPT_TIMEOUT_MS = 50_000;
    const attempt = () => postJson<{ ok: boolean; error?: string; leadId?: string; rm?: { name: string; phone: string; email: string } }>(
      `${this.baseUrl}/api/chat/select-offer`,
      { sessionToken, lenderName },
      ATTEMPT_TIMEOUT_MS,
    );
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ApiError) || err.message !== 'Request timed out') throw err;
      return await attempt();
    }
  }

  async resendOtp(sessionToken: string): Promise<{ ok: true } | { error: string; message?: string }> {
    return postJson(`${this.baseUrl}/api/chat/resend-otp`, { sessionToken });
  }

  // Non-critical lookup — an empty sidebar/empty match list is an acceptable degrade on failure,
  // so these two keep their original "swallow the error, return an empty result" behavior rather
  // than throwing (unlike every other call here, which now throws ApiError on failure).
  async profile(sessionToken: string): Promise<{ fields: { key: string; label: string; value: string; editable: boolean }[] }> {
    try {
      return await postJson(`${this.baseUrl}/api/chat/profile`, { sessionToken });
    } catch {
      return { fields: [] };
    }
  }

  async editField(
    sessionToken: string,
    field: string,
    value: string,
  ): Promise<{ ok: boolean; error?: string; display?: string; resultPayload?: unknown; summaryMessage?: string; eligibilityMessage?: string }> {
    return postJson(`${this.baseUrl}/api/chat/edit`, { sessionToken, field, value });
  }

  async panOffer(
    sessionToken: string,
    opts: { decision: 'decline' } | { pan: string; mobile?: string },
  ): Promise<{ ok: boolean; error?: string; resultPayload?: unknown }> {
    return postJson(`${this.baseUrl}/api/chat/pan-offer`, { sessionToken, ...opts });
  }

  async typeaheadSearch(searchKey: string, query: string): Promise<{ matches: string[] }> {
    try {
      return await postJson(`${this.baseUrl}/api/chat/typeahead-search`, { searchKey, query });
    } catch {
      return { matches: [] };
    }
  }

  async send(body: ChatMessageRequest): Promise<ChatTurnResponse> {
    try {
      const data = await postJson<unknown>(`${this.baseUrl}/api/chat/message`, body);
      return ChatTurnResponse.parse(data);
    } catch (err) {
      // Session expired server-side (Redis TTL + no Postgres row, or a stale sessionToken from
      // localStorage) — kept as its own error type since callers handle it very differently (start
      // a fresh session) from every other failure (show a retry).
      if (err instanceof ApiError && err.status === 404) throw new SessionExpiredError();
      throw err;
    }
  }
}

/** Shared by every call site that shows an inline "couldn't do X" message on failure — a rate limit
 * (429) gets its own wording instead of being lumped in with "something went wrong" (security-review
 * finding, 2026-10-23: a customer behind a shared office/carrier IP who trips the rate limit used to
 * see the exact same generic error as a real server failure, with no hint that waiting would fix it). */
// Bug fixed 2026-11-25 — this used to always return the generic fallback for anything but a 429,
// even once postJson started actually carrying the server's own message through. A customer whose
// session genuinely needed a restart (see postJson's own comment) still only ever saw "couldn't
// select this offer — try again shortly" and kept retrying the exact same doomed action.
const GENERIC_API_ERROR_MESSAGES = new Set(['Request timed out', 'Network error']);
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 429) return "You're sending requests too fast — please wait a moment and try again.";
  if (err instanceof ApiError && err.message && !GENERIC_API_ERROR_MESSAGES.has(err.message) && !/^Request failed \(\d+\)$/.test(err.message)) {
    return err.message;
  }
  return fallback;
}
