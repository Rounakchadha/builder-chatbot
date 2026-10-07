# Project summary — Home loan eligibility chatbot

Plain-language overview of what this project is and what's been built so far. Last updated 2026-10-05.

## What this is

A chat widget that a customer uses to check whether they'd be eligible for a home loan.
It's deliberately **not** an AI chatbot — there's no LLM, no free-text understanding, no
model calls. Every step is a fixed question, answered either by typing into a plain field
(like a phone number) or by tapping a button. Most of the data isn't just collected — it's
verified live against Finfinity's real backend systems (OTP, identity checks, credit
bureau, loan offers).

## Why it's built this way

- **Predictability over "smartness".** Because nothing is interpreted by an LLM, the bot
  can never misunderstand an answer, hallucinate a loan offer, or go off-script. Every path
  through the conversation is a fixed, testable sequence of steps.
- **Real data, not guesses.** Instead of asking the customer for income/credit info and
  estimating an answer, the bot actually calls Finfinity's backend to verify identity, pull
  a real credit score, and fetch real lender offers — so the result shown is a genuine
  eligibility outcome, not an estimate.
- **No repeat work for known customers.** If someone's already a Finfinity customer, their
  existing details are reused instead of asking the same questions again.

## How the conversation flows, step by step

1. Customer enters their mobile number and verifies it with an OTP. This is mandatory —
   there's no way around it, and it doubles as the lookup key to check if they're already a
   known customer.
2. If they're found, their saved details (income, segment, etc.) are pulled in automatically.
   If their PAN or email matches a *different* existing account, the bot asks them to verify
   with that account's number instead, so duplicate records don't get created.
3. They answer a short set of plain questions — customer segment, pincode, loan type,
   income, existing EMI, property details — all typed fields or button choices, nothing
   open-ended.
4. A second OTP confirms consent before pulling their credit bureau score (skipped if a
   recent score is already on file).
5. The server creates a real lead in Finfinity, syncs the financial details onto it, and
   fetches real lender offers. This is pre-fetched in the background where possible, so the
   result appears almost instantly once the customer reaches that point.
6. Customers can go back and edit certain answers (like income or EMI) from a details panel
   without restarting the whole conversation. There's also a "Start over" control for
   testers/admins to reset and try a different customer in the same browser.
7. If a customer leaves and comes back within 10 minutes, they're recognized automatically
   (via an opaque token stored in the browser — not their mobile number) so they don't have
   to OTP again.

## What's real vs. still mocked

Everything is a real call to Finfinity's backend once the server is configured with
Finfinity's API credentials. Without that configuration, it falls back to mock responses so
the flow can still be built and tested locally without needing live credentials.

| Piece | Status |
|---|---|
| OTP send/verify | Real |
| Identity / duplicate-customer lookup (by phone, PAN, or email) | Real |
| PAN detail lookup | Real |
| Lead creation | Real |
| Syncing financial details onto the lead | Real |
| Lender eligibility offers | Real |
| Credit bureau (CIBIL/Experian) score pull | **Still mocked** |

The bureau pull is mocked because Finfinity's real version isn't a single "give me a score"
API call — it's a two-step interactive flow (a CIBIL knowledge-based question, or an
Experian mobile OTP), which needs its own chat UI step designed before it can be wired in.
The groundwork for it already exists in `server/src/services/bureau.service.ts`.

## How the project is structured

- **`server/`** — The backend. Fastify (a Node.js web framework) + TypeScript, Postgres
  (via Prisma) for storage, Redis for session/cache data, and a custom "flow engine" that
  drives the conversation one step at a time.
- **`widget/`** — The actual chat widget the customer sees. Plain TypeScript (no React/Vue),
  built with Vite into a single self-contained `widget.js` file with styles baked in. It
  renders inside a Shadow DOM, which is a browser feature that fully isolates its styling
  from whatever page it's embedded on (so it can't break the host site's look, and the host
  site can't accidentally break the widget's).
- **`shared/`** — Type/schema definitions (using Zod, a validation library) shared between
  the server and widget, so both sides agree on the exact shape of data being passed around.
- **`test-page/`** — A plain HTML page used to manually test the widget locally, with an
  admin "reset" button for trying different test customers.

## Data model (what gets stored, and why)

- **Conversation** — One row per chat session. Anonymous until the mobile number is
  verified; tracks which step the customer is on and whether the session is in progress,
  completed, or abandoned.
- **Customer** — A known, deduplicated identity. This is the record checked against on every
  new conversation, and the one created once PAN + bureau consent are given. A customer can
  exist and be reused across multiple conversations over time, with or without ever
  producing a loan application (Lead).
- **Message** — The full chat transcript, for human (relationship manager/analyst) review.
- **FlowAnswer** — The actual source of truth for "what has this customer answered so far,"
  kept separate from the chat transcript so the flow engine never has to re-interpret free
  text to know what it already knows.
- **Lead** — Only created once a customer has consented to a PAN/credit check and that check
  succeeds. Represents a real loan application synced to Finfinity.
- **ConsentAudit** — An immutable log of every consent decision (yes/no to the PAN/credit
  pull), kept for compliance purposes.
- **KnowledgeChunk** — A planned FAQ knowledge base (for answering general questions like
  "what is FOIR/EMI") using retrieval rather than an LLM generating answers from scratch.
  Present in the schema but not yet wired into the conversation flow.

Sensitive data (PAN, name) is stored encrypted (AES-256-GCM), and mobile numbers are stored
as a hashed/masked value rather than in plain text anywhere in the database.

## Current state

- Core flow (OTP → identity check → questions → bureau consent → lead creation → offers) is
  implemented and tested (`server/test/` covers flow-engine branching and the eligibility
  math).
- Real integrations are live against Finfinity for everything except the credit bureau
  score, which still needs its own two-step UI designed before it can move off mock data.
- Open item from `PLANNING.md`: add Tailwind CSS to the widget's build (not done yet).
