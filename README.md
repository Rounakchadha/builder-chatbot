# Loan eligibility chatbot — version 1 (basic flow, no LLM)

The same product as [`../version2-llm`](../version2-llm) — same tech stack, same features
(mobile/OTP verification, PAN consent + CIBIL pull or self-declared score, segment/pincode,
product/loan type, income/EMI, property questions, eligibility computation across lenders, RM
assignment, lead creation, and a live editable profile panel) — with every LLM/NLU-dependent piece
removed. This is a deterministic, button-driven chatbot: no free-text understanding, no guessing,
no model calls, no API key to configure.

## Structure

- `server/` — Fastify + TypeScript API, Prisma/Postgres, Redis, the flow engine, and the two consent flows (PAN vs. self-declared score).
- `widget/` — Vanilla TS + Vite embeddable chat widget, styled with Tailwind, builds to a single
  self-contained `widget.js` (styles included). Renders inside a Shadow DOM so it never leaks
  styles onto (or inherits styles from) whatever page it's embedded on.
- `shared/` — Zod schemas / types shared by server and widget.

## What's different from version 2

- **`choice` steps render as clickable buttons** (matching the original
  `loan_eligibility_chatbot_flow_CIS.html` prototype), not a free-text field — the client always
  sends one of the exact option strings, so there's nothing to fuzzy-match or guess at.
- **No LLM guardrail.** There's no `services/llm.service.ts`, no Groq dependency, and no
  `GROQ_*` env vars. An answer that fails validation (bad OTP, invalid PAN, etc.) just gets its
  own plain error message back — no off-topic/greeting/domain-question detour handling.
- **No free-text "change my income to 90000" edits mid-conversation.** Corrections happen only
  through the explicit, structured "Your details" panel (`POST /api/chat/edit`), which still
  re-validates through the same step definition and recomputes eligibility.
- **No post-result follow-up chat.** Once eligibility is computed, the result card is the end of
  the conversation (aside from "Start over" and editing via the profile panel) — there's no
  open-ended lender Q&A bar, since that requires free-text understanding.
- Mobile/OTP/PAN/pincode/income/EMI are still plain typed fields (not "choice"), same as version 2
  — that's just data entry, not conversational NLU.

## Local setup

```bash
npm install
npm run build --workspace shared

# Postgres + Redis (ports 5435/6381 host-side, distinct from version2-llm's 5434/6380
# so both versions can run side by side)
docker compose up -d postgres redis

cp server/.env.example server/.env   # then fill in DATABASE_URL/REDIS_URL to match the ports above
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

Run tests: `npm run test --workspace server` (flow-engine branching + eligibility math, no DB/Redis required).

## What's stubbed vs. real

- **CIBIL pull, SMS/OTP delivery, Builder-module lead creation** are all mocked behind clean
  service interfaces (`server/src/services/*.service.ts`), same as version 2. Each throws a clear
  "not yet configured" error if you set its `*_API_BASE_URL`/`*_API_KEY` env var without also
  implementing the real call.
