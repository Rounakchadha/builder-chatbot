# Chatbot flows

Plain-language reference for every question the chatbot asks, in order, for each product. "(real)"
means it's a genuine call against Finfinity's backend; "(dummy)" means it's a placeholder until the
real API is confirmed and wired in.

Every conversation starts the same way:

1. **"Check my eligibility" or "Check an existing application"** — this doc covers the eligibility path.
2. **Mobile number.**
3. **OTP #1** (real) — confirms the number is theirs, and silently checks whether this mobile already belongs to a known Finfinity customer ("found") or not ("not found").

From here, *every* product — Home loan, LAP, Personal loan, Gold loan, Business loan — goes through the same identity steps below before picking which product they want:

4. **PAN** (real) — skipped if already found; if not found, their name/DOB are looked up from the PAN (real), and the system checks this PAN doesn't already belong to someone else's account (if it does, they're offered to verify with that account's number instead, or enter a different PAN).
5. **Email address** — same idea: skipped if already found; if not found, checked for a duplicate the same way PAN is.
6. **Pincode** — looked up and confirmed back (e.g. "400051 is Mumbai").
7. **Employment type** — Salaried / Business owner / Self-employed professional.
8. **OTP #2** (real) — consent to pull their credit (CIBIL) score. Skipped if a recent score is already on file.
9. *(silent)* credit score pulled, basic customer record created if new.

Only **after all of this** does the bot ask:

10. **"What are you looking for?"** — Home loan / Loan against property / Personal loan / Gold loan / Business loan.

---

## Home loan / Loan against property (real, unchanged)

Picking **Home loan** or **Loan against property** continues into the full, original flow — untouched by any of this session's new-product work:

11. **Fresh purchase or Balance transfer** (Loan against property also offers "Loan against property" as a loan type).
12. **Monthly income.**
13. **Existing EMIs** (or "no").
14. **Has the property been identified yet?** — Yes / Not yet (skipped for Balance transfer / already-owned LAP).
15. **Property type** — Home loan: Plot purchase / Row house / Bungalow / Apartment. LAP: Residential / Commercial / Industrial.
16. **Property value** (only if identified).
17. *(LAP only)* **Occupancy** and **Collateral type** (depends on property type picked).
18. **Recap message** — everything collected, shown before computing eligibility.
19. **Result** (real) — a lead is created with Finfinity, real lender offers are fetched, an RM is assigned, eligibility amount shown.

---

## Personal loan (dummy from here on)

Reuses the real name/PAN/email/segment/gender/credit score from steps 4–9 above — doesn't ask for them again. Gender comes from the same PAN lookup / dedupe match as name and DOB (confirmed live on both `getpandetail` and `searchcustomer`).

11. **Gender** — only asked if it wasn't already returned by the PAN lookup/dedupe match (fallback for the rare case it's missing).
12. **Loan amount required.**
13. **Monthly income.**
14. **Existing EMIs.**
15. **Employer** — type-to-search against a real list of ~182,000 companies (from the employer master file), or pick "Others" to type it in free-text.
16. **Lender offers shown** (dummy) + a dummy lead ID generated.
17. **"I agree" to Terms & Conditions / Key Fact Statement.**
18. **Father's name.**
19. **Mother's name.**
20. **Years with current employer.**
21. **Total years of work experience.**
22. **Highest qualification.**
23. **Residence address** (rejects a bare number/short word — must look like a real address).
24. **Residence pincode** (looked up and confirmed, same as step 6).
25. **Landmark near residence** (a real answer is required — "none"/blank is rejected).
26. **Residence type** — Owned / Rented / Family owned.
27. **Loan purpose** (free text).
28. **Recap message** — everything collected.
29. **Result** (dummy) — eligibility + lender offers + "Your lead (ID) has been created — [RM name] will reach out to you shortly."

---

## Gold loan (dummy from here on)

The shortest of the three — doesn't ask for PAN/email/segment at all (not part of its spec), but does reuse name/segment/credit score for the final summary if already known.

11. **Loan amount required.**
12. **Type of gold** — Jewellery / Coin / Bars.
13. **Purity** — 18k / 20k / 22k / 24k / Not sure.
14. **Gross weight (grams).**
15. **Loan purpose** — Personal need / Medical / Education / Business / Agriculture / Wedding / Other.
16. **Recap message.**
17. **Result** (dummy) — eligibility capped by an approximate gold value (purity × weight × ~75% LTV), lender offers, lead/RM message.

*(Simplification: only asks about one gold item, not a repeating list — revisit if multiple items need to be entered.)*

---

## Business loan (dummy from here on)

11. **Loan amount required.**
12. **What will you use it for?** — Working capital / Machinery purchase / Expansion / Inventory purchase.
13. **Business PAN** (asked fresh — can differ from the applicant's personal PAN for partnership/LLP/Pvt Ltd; only identical for a proprietorship).
14. **Business type** — Proprietorship / Partnership / LLP / Private limited / Public limited / OPC (asked directly — no PAN-based auto-detection API yet).
15. **GST registered?** — Yes/No (asked directly, same reason); if Yes, **GST number**.
16. **Business address** (same real-address validation as Personal loan).
17. **Landmark** (required, same as Personal loan).
18. **Business pincode** (looked up and confirmed).
19. **Industry** — Manufacturing / Trading / Services.
20. **Date of incorporation** — native date picker, can't pick a future date; years-in-business is calculated from this automatically.
21. **Annual turnover.**
22. **Annual profit** (can't exceed turnover).
23. **Recap message.**
24. **Result** (dummy) — eligibility capped at ~35% of annual turnover, lender offers, lead/RM message.

---

## What's still pending

- Real Finfinity product codes / `create_anacity_lead` / `getcustomeroffers` support for Personal/Gold/Business loan — once confirmed, their "Result" steps swap from dummy to real the same way Home loan already works.
- A real PAN-based lookup for Business loan's business type / GST registration (currently asked directly, per the spec's own fallback).
- Gold loan currently only supports one pledged item per application.
