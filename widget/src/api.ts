import { ChatTurnResponse, type ChatMessageRequest } from '@loan-chatbot/shared';

export class ChatApi {
  constructor(private baseUrl: string) {}

  async resendOtp(sessionToken: string): Promise<{ ok: true } | { error: string; message?: string }> {
    const res = await fetch(`${this.baseUrl}/api/chat/resend-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    return res.json();
  }

  async profile(sessionToken: string): Promise<{ fields: { key: string; label: string; value: string; editable: boolean }[] }> {
    const res = await fetch(`${this.baseUrl}/api/chat/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    if (!res.ok) return { fields: [] };
    return res.json();
  }

  async editField(
    sessionToken: string,
    field: string,
    value: string,
  ): Promise<{ ok: boolean; error?: string; display?: string; resultPayload?: unknown; summaryMessage?: string; eligibilityMessage?: string }> {
    const res = await fetch(`${this.baseUrl}/api/chat/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, field, value }),
    });
    return res.json();
  }

  async panOffer(
    sessionToken: string,
    opts: { decision: 'decline' } | { pan: string; mobile?: string },
  ): Promise<{ ok: boolean; error?: string; resultPayload?: unknown }> {
    const res = await fetch(`${this.baseUrl}/api/chat/pan-offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, ...opts }),
    });
    return res.json();
  }

  async typeaheadSearch(searchKey: string, query: string): Promise<{ matches: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/chat/typeahead-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchKey, query }),
    });
    if (!res.ok) return { matches: [] };
    return res.json();
  }

  async send(body: ChatMessageRequest): Promise<ChatTurnResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      // Session expired server-side (Redis TTL + no Postgres row, or a stale sessionToken from localStorage).
      throw new SessionExpiredError();
    }
    if (!res.ok) {
      throw new Error(`Chat request failed (${res.status})`);
    }
    return ChatTurnResponse.parse(await res.json());
  }
}

export class SessionExpiredError extends Error {}
