# Loan eligibility chatbot

A deterministic, button-driven chat widget that checks a customer's home-loan eligibility. No LLM,
no free-text understanding, no guessing, no model calls, no API key to configure — every step is a
fixed question with a typed field or a set of buttons, and most of the data it collects is verified
live against Finfinity's own backend (OTP, identity lookup, PAN, credit bureau score, lead
creation, lender offers).

## Structure

- `server/` — Fastify + TypeScript API, Prisma/Postgres, Redis, and the flow engine that drives the
  conversation step by step.
- `widget/` — Vanilla TS + Vite embeddable chat widget, builds to a single self-contained
  `widget.js` (styles included). Renders inside a Shadow DOM so it never leaks styles onto (or
  inherits styles from) whatever page it's embedded on.
- `shared/` — Zod schemas / types shared by server and widget.
- `test-page/` — a plain HTML page for embedding and manually testing the widget locally.

## How it works, in plain terms

1. The customer enters their mobile number and verifies it with an OTP (mandatory — there's no way
   to skip this). This OTP also checks whether they're already a known Finfinity customer.
2. If they're found, their existing details (income, segment, etc.) are reused instead of being
   asked again. If their PAN or email matches a different existing account, the chatbot asks them
   to verify with that account's number instead of creating a duplicate.
3. They answer a short set of questions (segment, pincode, loan type, income, EMI, property
   details) — all plain typed fields or button choices, no free text to interpret.
4. A second OTP confirms consent to pull their credit bureau score, unless we already have a
   recent one on file for them.
5. The server creates a real lead with Finfinity, syncs the financial details onto it, and fetches
   real lender offers — shown to the customer as an eligibility result card, pre-fetched in the
   background where possible so it appears almost instantly.
6. Customers can revisit and edit certain answers (e.g. income/EMI) from a details panel without
   restarting the whole conversation; a "Start over" control lets testers/admins reset identity and
   try a different customer in the same browser.
7. If a customer returns within 10 minutes, their verified identity is remembered (stored as an
   opaque token in the browser, not the mobile number itself) so they don't have to OTP again.

## Local setup

```bash
npm install
npm run build --workspace shared

docker compose up -d postgres redis

cp server/.env.example server/.env   # then fill in DATABASE_URL/REDIS_URL/FINFINITY_* as needed
cd server
npx prisma migrate dev --name init
npm run dev          # starts the API on :8091 (or PORT from .env)
```

In another terminal:

```bash
cd widget
npm run build         # emits dist/widget.js (styles included, no separate CSS file)
```

Embed on a test page — just one script tag, no stylesheet link needed:

```html
<script src="./widget.js" data-api-base="http://localhost:8091" defer></script>
```

Or just open `test-page/index.html` (served locally), which already has the widget wired up plus an
admin "Start over" button for testing with different customers.

Run tests: `npm run test --workspace server` (flow-engine branching + eligibility math, no DB/Redis
required).

## What's real vs. still mocked

Everything below is a real call against Finfinity's backend once `FINFINITY_API_BASE_URL` is set in
`server/.env`; without it, the server falls back to mock implementations so the flow can still be
developed/tested locally without credentials.

- **Real**: OTP send/verify, identity/duplicate lookup (by phone, PAN, or email), PAN detail
  lookup, lead creation, lead financial sync, and lender eligibility offers.
- **Still mocked**: the credit bureau (CIBIL/Experian) pull. Finfinity's real bureau check is a
  two-step interactive flow (a CIBIL knowledge question, or an Experian mobile OTP) rather than a
  single "give me a score" call, so it needs its own UI step designed before it can be wired in —
  see the comments in `server/src/services/bureau.service.ts` for exactly what's ready to use once
  that step is built.
