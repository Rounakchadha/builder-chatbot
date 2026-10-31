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

// 15s, not the browser's unbounded default — these are chat-step calls (a few hundred bytes), not
// uploads, so a hung connection should surface as a retryable error well before a customer gives up
// staring at a spinner.
const DEFAULT_TIMEOUT_MS = 15_000;

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
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export class ChatApi {
  constructor(private baseUrl: string) {}

  async goldSubmit(sessionToken: string): Promise<{ ok: boolean; alreadyExists?: boolean; message?: string; leadId?: string; rm?: { name: string; phone: string; email: string } }> {
    return postJson(`${this.baseUrl}/api/chat/gold-submit`, { sessionToken });
  }

  async selectOffer(sessionToken: string, lenderName: string): Promise<{ ok: boolean; error?: string; leadId?: string; rm?: { name: string; phone: string; email: string } }> {
    return postJson(`${this.baseUrl}/api/chat/select-offer`, { sessionToken, lenderName });
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
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 429) return "You're sending requests too fast — please wait a moment and try again.";
  return fallback;
}
