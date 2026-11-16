# Adding a Home Loan lender here

Every real DMN decision table shared so far (common_parameter, for_age, Income_Norms, for_repo_rate,
lender_foir, lender_loan_amount, lender_pf, lender_rate) is a pure, dense decision table — no
narrative/composite logic like pl-eligibility-precheck's DPD windows or tradeline checks. So a new
lender here is pure DATA, not a hand-written gate function — see `../decisionEngine.ts` for the one
generic evaluator every lender's data feeds into.

1. **Transcribe the lender's real rows from each of the 8 sheets into a new `<lenderName>.ts` file**
   in this folder, typed against `./types.ts`'s `LenderDecisionData`. Copy an existing file close in
   shape to the new lender as a starting template (e.g. `hdfcBankHl.ts` for a dense rate table tiered
   by both income and CIBIL, `piramalHousing.ts` for one tiered by income only, `iiflHl.ts` for a
   completely flat rate).
   - Preserve the source's own comparator exactly (`>` vs. `>=`) — don't normalize unless the values
     are integers where it's mathematically lossless (see `types.ts`'s `minCibil` comment for the
     convention already used there).
   - A `"0"`/`"-1"` bureau_score row is always priced identically to its counterpart in every lender
     seen so far — merge them into one `{ noFile: true, ... }` row rather than transcribing two
     near-duplicates.
   - If a gap exists in the source (a CIBIL/income range with no matching row, an employment type
     with no coverage at all), leave it as a real gap — don't invent a rate or threshold to fill it.
     `decisionEngine.ts` already surfaces an unmatched case honestly as "no matching rate tier" or
     "no published policy covers this employment type".
   - Document any real anomaly (an inconsistent naming between sheets, a malformed cell, a genuinely
     one-sided accept rule like Aadhar Housing's) in a top-of-file comment, same as every existing
     lender file does — never silently normalize it away.
2. **Add the lender code to `../types.ts`'s `LenderCode` union** — suffixed/named so it can never
   collide with a pl-eligibility-precheck code for the same bank name.
3. **Wire it into `../engine.ts`'s `LENDER_DATA`** and **`../server.ts`'s `VALID_LENDERS`** — both,
   every time (a real PL-service bug was once caught from only updating one of the two).
4. **Write a real test file** in `../../test/` — at minimum, a boundary case per gate (age, CIBIL,
   income, FOIR) and 2–3 rate lookups that pin exact transcribed values, so a future edit that
   silently changes a number gets caught immediately. Run `npm run smoke` too — it prints every
   lender's result for a few representative profiles, useful for an eyeball sanity check.
5. **Update the top-level `../../README.md`**'s lender list and, if relevant, its anomalies/gaps
   section.

Never port a Personal Loan number across to a Home Loan lender file (or vice versa) just because
it's the same bank — a bank's PL and HL products are different products with different real
policies. Every number here must trace to a real Home Loan DMN/source.
