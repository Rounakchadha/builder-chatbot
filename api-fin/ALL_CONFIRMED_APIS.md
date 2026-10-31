# All Finfinity backend APIs — confirmed state (as of 2026-10-21)

Base URL: `https://backend.uatfinfinity.in/api/v1` (`FINFINITY_API_BASE_URL` in `server/.env`).
Every endpoint lives under `/leadflow/...` and shares one response envelope:
```json
{ "data": [...], "error_msg": "...", "error_code": "", "error_dtl": ..., "activity": null }
```
`error_code: ""` means success. A non-2xx HTTP status comes back as Django's own generic
`{"detail": "..."}` shape instead (no `error_code` at all) — see `finfinityClient.ts`.

Auth: no separate login. A successful `validateotpv2` (or `validatebureau`) returns a fresh
`access`/`refresh` JWT pair right in its own response — that's the bearer token every other
authenticated call in the conversation uses, re-issued each time one of those two run.

Status legend: ✅ wired in & working · ⚠️ confirmed working but NOT wired into the chatbot yet ·
❌ confirmed broken on Finfinity's side · 🚫 deprecated/replaced, do not use.

---

## Identity / OTP

### ✅ `POST /leadflow/generateotpv2`
Sends an OTP. Public, no bearer token.
```json
{ "recipient": "9876543210" }
```
Wired in: `server/src/services/sms.service.ts` (`RealSmsService.sendOtp`).

### ✅ `POST /leadflow/validateotpv2`
Verifies the OTP. Public, no bearer token. Creates/resolves a customer as a side effect and
returns the first access/refresh token pair of the conversation.
```json
{ "recipient": "9876543210", "otp": "123456", "creation_type": "MOBILE" }
```
Two different response shapes depending on whether the customer already existed:
- New customer (`error_code: "CUST_NOT_EXIST"` — this is a SUCCESS flavor, not a real error):
  `[{customer_id, corporate_id}, {access, refresh}]`
- Already-known customer: one object with the full profile plus `token: {access, refresh}` nested.
Known error codes: `OTP401`/`OTP_EXPIRED` (wrong/expired code — not transient), `FOUND404`
("Customer Already Exists" — treat as a successful verify with no new id).
Wired in: `sms.service.ts` (`RealSmsService.verifyOtp`).

### ✅ `POST /leadflow/searchcustomer`
Dedupe lookup, by mobile OR (confirmed live) by `pan`/`email` as alternate keys.
```json
{ "phone_number": "9876543210" }
// or { "pan": "ABCDE1234F" }  or  { "email": "x@y.com" }
```
Response fields actually seen live: `id, customer_name, first_name, middle_name, last_name, dob,
primary_email, official_email, primary_phone_number, pan_number, service_pincode,
customer_segment, residenceStatus, countryCode, nationalityId, bureau_score, bureau_type,
bureau_fetch_date, need_refresh, need_consent`. No `gender` field on this endpoint (confirmed
live, 2026-10-05) — only `getpandetail` has it.
A bare shell record (mobile only, no `pan_number`) is created by `validateotpv2` for every
genuinely brand-new person — we treat "match but no PAN" as not-found.
Wired in: `dedupe.service.ts` (`RealDedupeService.check` and `.matchBy`).
Error code `CUSTOMER_NOT_FOUND` → treat as a clean null match, not a failure.

### ✅ `POST /leadflow/updatecustomerv3`
Partial-update a customer record — only send the fields you're actually changing.
```json
{ "customer_id": 33326, "update_fields": { "pan": "...", "primary_email": "...", "official_email": "...", "service_pincode": "...", "applicant_type": "salaried" } }
```
Wired in: `dedupe.service.ts` (`RealDedupeService.updateCustomer`).

### ✅ `POST /leadflow/getpandetail`
PAN → identity (name/DOB/gender). No credit data.
```json
{ "panNumber": "ABCDE1234F" }
```
Response: `[{ response: { pan, name, dob /* DD/MM/YYYY */, gender? } }]`. Note the double-space
gap in `name` for anyone without a middle name (e.g. `"SPARSH  GUPTA"`).
Wired in: `pan.service.ts` (`RealPanService.lookup`).
Error: a 400/"invalid pan" response → genuine "not a real PAN", not an outage.

### ⚠️ `POST /leadflow/pantogstin`
PAN → full GST registration list (one GSTIN per state the entity is registered in), including
`constitutionOfBusiness` (entity type as a plain string, e.g. `"Private Limited Company"`).
Confirmed live and working (2026-10-16).
```json
{ "applicationId": 75942, "panNumber": "ABLCS1773K" }
```
`applicationId` just needs to be SOME real lead id on the account — confirmed it does NOT need
to belong to the same product/journey being looked up (tested with an unrelated PL lead id and
it still worked fine against a different PAN).
Response (success): `data[0].response.gstListAdvanced[]`, each entry has `gstin`,
`constitutionOfBusiness`, `legalNameOfBusiness`, `tradeName`, `sts` ("Active"/etc.),
`effectiveDateOfRegistration`, `principalPlaceOfBusiness`, `state`, and more.
Response (no GST on this PAN): `data[0].response = { "code": 404, "message": "GSTIN List not found" }`
— not an HTTP error, just an empty result; handle gracefully, don't throw.
Wired in: `server/src/services/businessLoan.service.ts` (`RealBusinessLoanService.fetchGstFromPan`).

### 🚫 `POST /leadflow/fetchpantogst`
Looked like an alternate PAN→GST endpoint from an early doc. Tested live (2026-10-16),
consistently returns `{"error_code": "FD001", "error_msg": "Error in Fetching"}` — broken or
wrong endpoint name. Use `pantogstin` instead. Not wired in anywhere.

---

## Bureau / CIBIL

### ⚠️ `POST /leadflow/generatebureau` + `POST /leadflow/validatebureau`
The real bureau pull is NOT a single request/response — `generatebureau` starts it and returns
either a CIBIL knowledge-based question or an Experian mobile-OTP challenge; only
`validatebureau` (with that question answered, or the OTP entered) returns the actual score.
This is a real two-turn interactive flow that needs its own step type designed into the
conversation — the HTTP plumbing exists (`realBureauApi` in `bureau.service.ts`) but
`RealBureauService.pull()` deliberately throws rather than being wired in, since a plain
"one call → one score" interface can't represent it. The chatbot currently uses a mock bureau
score for every real conversation because of this gap — `FINFINITY_BUREAU_MOCK_OVERRIDE`.

`generatebureau` request: `{ pan, phone_number, official_email, pincode, applicant_type_key }`
(e.g. `applicant_type_key: "salaried"`). Response (CIBIL): `{questionKey, answerKey,
ChallengeConfigGUID, otp_session_id, customer_id, bureau_type: "CIBIL"}`. Response (Experian):
`{otp_session_id, customer_id, bureau_type: "EXPERIAN"}`.

`validatebureau` request (CIBIL): `{customer_id, bureau: "CIBIL", otp_session_id, phone_number,
questionKey, answerKey, ChallengeConfigGUID}`. Request (Experian): `{customer_id, bureau:
"EXPERIAN", otp_session_id, phone_number, otp}`. Response: `[{bureauScore, bureauType,
ReferenceKey?, stageOneId?, stageTwoId?}, {access, refresh}]` — also reissues a fresh token pair.

See `api-fin/bureau_api_payloads.txt` and `api-fin/experian_refresh_api_payloads.txt` for the
partner's own original examples.

---

## Lead creation & product-agnostic lead actions

### ✅ `POST /leadflow/create_anacity_lead`
THE lead-creation call for every single product now (confirmed live for all six: HL, LAP, LAS,
GL, PL, BL, 2026-10-16). Returns a real, immediately-assigned relationship manager in its own
response — the one thing `createcorplead` (below) never did.
```json
{ "customer_id": 33326, "product_code": "HL", "campaign_code": "anacity" }
```
`product_code`: `HL`, `LAP`, `LAS`, `GL`, `PL`, `BL`.
`campaign_code`: use `"anacity"` — the docs' example value `"FINFINITY"` is not a real registered
campaign and crashes the endpoint (`"Error processing UTM params"` / `"object of type 'NoneType'
has no len()"`), confirmed live. Ask the partner for the real production campaign code once one
exists.
Response: `data[0] = { leadid, customer_id, product_code, rm_name, rm_email, rm_mobile_number }`.
On this session, every lead came back with the SAME RM — Anirudh Gupta / anirudh@finfinity.co.in
/ 7206672332 — presumably a single default/test RM on UAT.
Wired in: `lead.service.ts` (`RealLeadService.createLead`) — used by every product's flow.

### 🚫 `POST /leadflow/createcorplead`
The OLD lead-creation call. Never returns an RM (confirmed live, repeatedly). Fully replaced by
`create_anacity_lead` as of 2026-10-16 — removed from the codebase entirely. Payload for
reference only: `{ phonenumber, official_email, product_id, campaign_code }`.

### ✅ `POST /leadflow/updatelead`
Home Loan/LAP only — syncs income/EMI/property details onto an already-created lead.
`getcustomeroffers` needs this data on the lead before it can compute anything.
```json
{
  "leadid": 75918,
  "loan_type": "fresh",            // "fresh" (purchase) | "lap" | "loan_takeover" (BT) | "bt+topup"
  "monthly_income": 1000000,
  "bonus_income": 0,
  "rental_income": 0,
  "existing_emi": 0,
  "property_identified": "Yes",     // or "No"
  "property_type": "apartment/flat",// see the confirmed-value table below, or "" if not identified
  "occupancy_type": "self_occupied",// lowercased + underscored, e.g. "Self-occupied" -> "self_occupied"
  "collateral_type": "restaurant",  // lowercased + underscored — SEE BUG below
  "property_value": 7000000,
  "seller_type": "builder",         // "builder" once a property is identified, "" if not (2026-10-16)
  "completion_status": "completed", // "yet_to_start" if property_type/collateral is a plot
  "carpet_area": "1000",            // fixed placeholder, always this value
  "resale_flag": false              // always false — never a resale in this flow
}
```
**`loan_type` BUG, confirmed live and FIXED (2026-10-21):** the old value `"balance_transfer"` is
rejected outright by this endpoint for BOTH Home Loan AND LAP —
`{"error_msg": "Loan type 'Balance Transfer' is not valid for product HL"}` (same for `LAP`) — even
though the endpoint itself recognizes the string well enough to echo it back as `'Balance Transfer'`
in the error. Silently broke every Balance Transfer customer's income/EMI sync (caught, logged,
swallowed by `syncLeadFinancials`), which meant eligibility got computed with no financial data at
all and returned wildly inflated numbers — this is why a customer could enter a huge EMI and still
see crore-level eligibility. The real value, confirmed by the partner (Mohammad Shahanawaz) and
re-verified live on fresh HL lead 76137 and LAP lead 76062 (`"Lead Updated Successfully"` both
times): **`"loan_takeover"`**. A `"bt+topup"` value also exists and was verified working
(`resolved.loan_type.name: "BT+Topup"`) but isn't wired in — no top-up option exists anywhere in
this flow for a customer to actually choose it.

**`property_type` values, confirmed live (2026-10-21)** — our own naive
`.toLowerCase()` of the display option does NOT match their expected key for 2 of our 4 Home Loan
options:
| Our option | What we send | Works? |
|---|---|---|
| Apartment | `apartment` | ❌ `INVALID_PROPERTY_TYPE` |
| Apartment | `apartment/flat` | ✅ resolves to `{id: 12, key: "apartment/flat", name: "Apartment/Flat"}` |
| Plot purchase | `plot purchase` | ❌ `INVALID_PROPERTY_TYPE` |
| Plot purchase | `plot` | ✅ resolves to `{id: 7, key: "plot", name: "Plot"}` |
| Row house | `row house` | ✅ resolves to `{id: 9, key: "row_house", name: "Row House"}` |
| Bungalow | `bungalow` | ✅ resolves to `{id: 8, key: "bungalow", name: "Bungalow"}` |
LAP's own options (`residential`/`commercial`/`industrial`) are recognized strings but explicitly
`"not valid for product HL"` when tried on an HL lead — they're LAP-only, as expected; not
re-verified as LAP's own correct values this session (assumed still correct from the 2026-10-16
confirmation below).

`collateral_type` has a strict server-side whitelist — confirmed it REJECTS `"apmc"`, `"No"`,
`"none"`, `"na"`, `"not_applicable"` outright with `{"error_code": "INVALID_COLLATERAL_TYPE",
"error_dtl": "collateral_type=<value>"}`. We don't have the full accepted list.
Wired in: `lead.service.ts` (`RealLeadService.updateLead`).

### ❌ `POST /leadflow/getcustomeroffers` — BROKEN for LAP
Home Loan/LAP's real BRE offers call, keyed by lead id (not raw income/segment).
```json
{ "leadid": 75918, "product_code": "LAP" }
```
Omitting `product_code` crashes it with a Python `KeyError: 'product_code'` (confirmed live,
2026-09-23) — it's required even though the docs only show it for PL/EL/AL.
Response shape (confirmed live): the real payload is nested one level deeper than the docs'
example — `data[0].data[0]` holds `{final_lender_list[], rejected_lender_list[], exec_status}`.
Each `final_lender_list` entry: `{lender_name, eligibility_amount, rate, emi, min_tenure,
max_tenure, ltv}`.
**CONFIRMED BROKEN for `product_code: "LAP"` as of 2026-10-16** — crashes with
`{"error_code": "EXEC_ERR", "error_msg": "cannot unpack non-iterable NoneType object"}` on
EVERY attempt regardless of input (tested: full valid collateral data, collateral omitted
entirely because property wasn't identified, `collateral_type` sent blank, and several invalid
sentinel values — all produce the identical crash). Reproduction lead ids: 75918, 75921, 75922,
75928, 75930, 75931-75934. Reported to Priyanshu (Bitsflow) 2026-10-16 — root cause traced to
`collateral_type`/`occupancy_type`/`property_type` being blank/null in their BRE workflow input
even when `updatelead` itself accepted the lead cleanly (lead 75921 proved it's not just "field
missing" — a syntactically valid, accepted value like `"restaurant"` still crashes it, meaning
their BRE's own internal lookup table doesn't recognize it either). Fix is pending on their side.
Home Loan (`product_code: "HL"`) has NOT been confirmed broken the same way — only LAP has been
reproduced failing this session; worth testing HL specifically to see if it's LAP-only. **Update
2026-10-21:** HL confirmed genuinely working, repeatedly, across many live test leads this
session — real 13-20-lender `final_lender_list` responses, correctly reflecting a pushed
`existing_emi` (verified: pushing a large EMI onto a lead measurably dropped its eligibility from
several crore down to ~₹10.5 lakh). Still worth re-testing LAP specifically to see if their fix for
the LAP crash (reported to Priyanshu/Bitsflow) has landed.
Wired in: `eligibility.service.ts` (`RealEligibilityService.evaluate`).

### ✅ `POST /leadflow/setbrefinanceroffertenure`
Records the customer's chosen tenure for whichever offer they picked. Confirmed live to work
identically across Home Loan, LAP, and Personal Loan leads.
```json
{ "leadid": 75918, "hasMultipleTenure": "N", "tenure": "36" }
```
Wired in: `lead.service.ts` (`RealLeadService.setOfferTenure`).

### ✅ `GET /leadflow/fetchstatusdata/<leadid>`
Post-completion status polling (not part of the live create→eligibility flow).
Response: `data[0] = { remarks, assign_to, statusData: {id, key, value, metadata_type,
metadata_name, description}, bpData, lenderData }` — `statusData.value` is the display status
(e.g. `"Application Accepted"`).
Wired in: `status.service.ts` (`RealStatusService.getStatus`). Known gap: the "check an existing
application" conversation branch has no OTP step of its own, so there's often no fresh access
token to pass here — needs its own auth step designed in.

---

## Personal Loan

Two completely independent paths exist for PL eligibility — a real Finfinity 5-call chain, and a
standalone pre-check microservice. **The real chain is the active one now (switched on
2026-10-21, `PL_REAL_FINANCER_CHAIN_ENABLED=true`)**; the microservice still runs in the background
on every check purely to compare against it (see `personalLoan.ts`'s `runOwnBreComparison`,
persisted to the `PlBreComparison` table) — explicit instruction: "dont run our bre yet... use
these for now... also run the our BRE in the background and check everytime a new offer is tested."

### ✅ The real 5-call chain (confirmed live end-to-end, 2026-10-21)
1. `create_anacity_lead` (`product_code: "PL"`) — already generic, see above.
2. `POST /leadflow/financerwiseeligibility` — runs the real BRE across EVERY lender in ONE call.
   ```json
   { "customer_id": 33326, "leadId": 75942, "monthly_income": 50000, "obligation": 0, "bureau_score": 750 }
   ```
   Response: `data[0].data[0] = {final_lender_list[], rejected_lender_list[], exec_status}` — same
   nested shape as `getcustomeroffers`. Each lender entry: `lender_name, company_category, foir,
   min_tenure, max_tenure, min_loan_amount, max_loan_amount, pf (format INCONSISTENT — some
   percentages like "4%", some flat rupee amounts like "5999"), rate, key, emi,
   eligibility_amount, kfs, hasMultipleTenure, steps[], journey_stage, pt, link, route, tags[]`.
   Confirmed live returning 13 real lenders (Poonawalla, Tata Capital, Bajaj Finserv, IndusInd,
   Unity Bank, Axis, Aditya Birla, Chola, Piramal, Fullerton, Hero Fincorp, Kotak Bank, IDFC Bank)
   plus a rejected list (HDFC, in our test case).
3. `POST /leadflow/setcorpamtten` — writes the customer's chosen lender/amount/tenure onto the lead.
   ```json
   { "leadid": 75942, "req_loan_amount": "500000", "req_tenure": "36", "emi": "16500", "lender_name": "Poonawalla Fincorp Limited", "roi": "10.99", "pf_amount": "10000", "eligible_loan_amount": "1000000", "eligible_tenure": "72" }
   ```
4. `POST /leadflow/pl_financer_offer` — recomputes the FINAL confirmed numbers for exactly that
   lender/amount/tenure. **Previously documented BROKEN (NameError, then UnboundLocalError on
   `tenure`) — now confirmed FIXED and working live (2026-10-21)**, once called with real synced
   data (steps 2+3 above) rather than a bare lead. Response includes a full `applicant_list`
   (`employment_type, monthly_obligations, age, monthly_income, bureau_score,` etc.) plus
   `final_eligibility, total_amount, interestAmount, exec_status`.
5. `setbrefinanceroffertenure` — confirms the tenure, already generic (see above); called last.
Wired in: `server/src/services/personalLoanFinancer.service.ts`
(`RealPersonalLoanFinancerService`), `flows/personalLoan.ts`, `routes/chat.ts`'s `/select-offer`.

### ✅ (separate system) `FINFINITY-BRE-MAIN/pl-eligibility-precheck`
NOT a Finfinity backend endpoint — a standalone microservice (runs locally on port 8095) this
chatbot calls directly for Personal Loan eligibility (Poonawala Fincorp / Tata Capital / Unity
Small Finance Bank). No longer the customer-facing path (see above) — now runs silently in the
background on every check, purely to compare its numbers against the real chain's, for calibrating
our own BRE over time. See `server/src/services/personalLoanEligibility.service.ts` for the full
request/response shape and gate logic (FOIR, CIBIL, employment type, bureau-depth facts,
lender-specific policy rules). **Bug fixed 2026-10-21:** its own fail-open fallback (used when this
microservice is unreachable) was missing `maxTenureMonths`, which `personalLoan.ts`'s own
offer-building code silently discarded (`!result.maxTenureMonths` → drop) — meaning any outage here
silently failed CLOSED instead of open, showing "no eligibility" for even a strong profile.

---

## Gold Loan (Muthoot)

Doc titled "Gold loan Lead API for Mannapuram" but all the actual field values/function names are
Muthoot-specific (`MUTHOOT GOLD`, `muthootleadgeneration`) — a naming inconsistency in the
partner's own doc, followed as given.

### ✅ `POST /leadflow/setmuthootlenderoffer`
Attaches Muthoot as the lead's chosen lender.
```json
{ "leadid": 75918, "lender_name": "MUTHOOT GOLD" }
```
Error `FRM_LENDER_EXHAUSTED` ("Lead Already Exist") — Finfinity enforces ONE active Muthoot gold
loan lead per customer at a time. This is a real, expected state (a genuine repeat customer), not
a bug — handled gracefully, not thrown.
Wired in: `goldLoan.service.ts`.

### ✅ `POST /leadflow/muthootleadgeneration`
The actual submission to Muthoot.
```json
{ "leadid": 75918 }
```
Error `208` / "already exist" → already submitted, handled gracefully.
**Success-shaped-as-error quirk, confirmed live (2026-10-21):** this endpoint sometimes returns its
SUCCESS in the error envelope shape — `error_code: "200"`, `error_msg: "Lead Created Successfully"`
— which `finfinityClient.ts`'s generic "any non-empty error_code is a failure" rule misread as a
real error. Every genuinely successful Muthoot submission was being reported to the customer as
"couldn't submit this application" and skipped the RM email. Not safe to allowlist `"200"` globally
in `finfinityClient.ts` (too generic a code to assume success everywhere) — handled narrowly in
`goldLoan.service.ts`'s own catch block instead, specific to this one endpoint.
Wired in: `goldLoan.service.ts`.

**Architecture change, 2026-10-21 ("we already get the rm before we click the muthoot loan"):**
`create_anacity_lead` now fires immediately when the customer enters the Gold Loan branch (same
"create the lead the moment we can" pattern as every other product), giving a real lead + real RM
from the very first result screen — no more placeholder `pickRm()` shown before the customer acts.
Only `setmuthootlenderoffer` + `muthootleadgeneration` (the two calls that actually consume the
"one Muthoot lead per customer" slot) still wait for the explicit "Submit to Muthoot" tap; a plain
`create_anacity_lead` never touches that constraint at all, so there was never a reason to defer
the lead itself. Wired in: `flows/goldLoan.ts`'s `glCreateLead` (early) +
`goldLoan.service.ts`'s `submitApplication` (now takes an already-existing `leadId`/`rm`, no
longer creates the lead itself).

---

## Business Loan

### ✅ `POST /leadflow/businessloandtl`
Saves the full business/entity profile onto an already-created (`create_anacity_lead`,
`product_code: "BL"`) lead.
```json
{
  "leadId": 75802,
  "business_name": "...",
  "business_name_flag": true,
  "gstin": "22AAAAA0000A1Z5",
  "nature_of_business": 465,
  "constitution_type": 121,
  "business_vintage": "",
  "date_of_incorporation": "2020-01-15",
  "business_addr1": "...",
  "udyog_registration_no": "",
  "loan_purpose": 24,
  "requested_loan_amount": "1000000"
}
```
Rejects any unrecognized id with a generic `"Error in saving"` / `CUSTSRV143` and no further
detail — confirmed by testing placeholder `1` for all three fields before the real master-data IDs
were shared.

**`profession_type` BUG history, now REMOVED entirely (2026-10-21):** the originally-documented ids
(Proprietorship=497, Partnership/LLP=563, Private/Public limited=562, OPC=564, shared 2026-10-15)
were confirmed BROKEN live — `497` in particular rejected EVERY proprietorship's save with
`CUSTSRV143`/"Error in saving", despite being the partner's own documented value at the time. The
partner then re-seeded this master table with new ids (Proprietorship=409, Director/Private
limited=492, Partner/Partnership=493, OPC=494) — all four re-confirmed live — but the field was
then replaced entirely rather than kept: **direct instruction "we have to send only constitution
type 121 123 and 209" / "remove the old codes".** `profession_type` is no longer sent at all.

**`constitution_type` (`ConstitutionType` master table) — the field actually sent now, confirmed
live (2026-10-21):**
- Proprietorship = **121** (`proprietorship`)
- Private limited = **123** (`private_limited`) — also reused for Public limited/OPC, no distinct
  row given for either
- Partnership Firm = **209** (`partnership_firm`) — also reused for LLP, no distinct row given
Only these 3 ids were given, matching our 3 supported entity categories (individual/company/
partnership — see `panEntityCategory`).

- `nature_of_business` (`BusinessNatureType`): Manufacturing=465, Trading=464, Services=466
- `loan_purpose` (`BL_LoanPurpose`): Working capital=24, Purchase/Upgrade of Machinery AND
  Renovation of Business=27 (one combined real row, split into two customer-facing options on our
  side), Expansion=26, Inventory purchase=23
Wired in: `businessLoan.service.ts` (`RealBusinessLoanService.saveDetails`).

### ⚠️ See `pantogstin` above — this is Business Loan's working GST/entity-type auto-detect, now
wired into `businessLoan.service.ts`/`flows/businessLoan.ts` (2026-10-16).

---

## Things confirmed WITHOUT a real API (client-side logic only)

- **PAN 4th-character entity-type code** — not an API, a fixed rule from the Income Tax
  Department's own PAN structure (partner-confirmed table, 2026-10-16):
  `P`=Individual, `C`=Company, `F`=Firm/LLP, `H`=HUF, `A`=AOP, `T`=Trust, `G`=Government,
  `B`=Body of Individuals, `L`=Local authority. Implemented in `businessLoan.service.ts`'s
  `panEntityCategory()` + `flows/businessLoan.ts`. For `C` (Company)/`F` (Firm/LLP), the fuller
  table calls for disambiguating Private/Public/OPC (or Partnership/LLP) via a CIN/LLPIN lookup or
  the registered business name — **confirmed (checked against the partner's own `APIS.md`,
  2026-10-16) there is no CIN/LLPIN lookup endpoint anywhere we've been given.** The business-name
  half IS available, though: `pantogstin`'s `gstListAdvanced` entries already carry
  `legalNameOfBusiness`/`tradeName` — wired in (`PanToGstResult.businessName`) and used both to
  show the customer what we found and to fill `businessloandtl`'s `business_name` with something
  real instead of the business PAN placeholder it used before. This only resolves things when GST
  data exists, though — `constitutionOfBusiness` (also in that same response) already gives a
  direct, definitive entity type whenever GST data is present, so the narrowed
  Partnership/LLP-or-Private/Public/OPC question from `panEntityCategory` only actually gets shown
  to the customer when GST data isn't available at all (no GST, no name, no automatic answer).

---

## File map (where each is implemented)

| Endpoint | File |
|---|---|
| generateotpv2, validateotpv2 | `server/src/services/sms.service.ts` |
| searchcustomer, updatecustomerv3 | `server/src/services/dedupe.service.ts` |
| getpandetail | `server/src/services/pan.service.ts` |
| generatebureau, validatebureau | `server/src/services/bureau.service.ts` (HTTP ready, not wired into a flow step) |
| create_anacity_lead, updatelead, setbrefinanceroffertenure | `server/src/services/lead.service.ts` |
| getcustomeroffers | `server/src/services/eligibility.service.ts` |
| fetchstatusdata | `server/src/services/status.service.ts` |
| setmuthootlenderoffer, muthootleadgeneration | `server/src/services/goldLoan.service.ts` |
| pantogstin, businessloandtl | `server/src/services/businessLoan.service.ts` |
| financerwiseeligibility, setcorpamtten, pl_financer_offer | `server/src/services/personalLoanFinancer.service.ts` |
| fetchpantogst, createcorplead | NOT wired in anywhere — broken/deprecated |

Older partner-doc payload examples (pre-dating most of the live testing above) are still in this
same folder: `bureau_api_payloads.txt`, `create_anacity_lead_api_payloads.txt`,
`experian_refresh_api_payloads.txt`, `fetchstatusdata_api_payloads.txt`,
`getcustomeroffers_api_payloads.txt`, `getpandetail_api_payloads.txt`, `otp_v2_api_payloads.txt`,
`searchcustomer_api_payloads.txt`.
