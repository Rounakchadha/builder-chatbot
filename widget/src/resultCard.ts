import type { EligibilityResultPayload, LenderOffer } from '@builder-chatbot/shared';
import { ICON } from './icons';

function initials(name: string): string {
  const letters = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="la-initials">${letters}</span>`;
}

/** Real lender logos where we have them (see widget/src/assets/lenders) — falls back to the
 * initials circle for anyone not in this list (e.g. Fullerton — no usable public logo found for
 * these; Muthoot/L&T Housing Finance/Aadhar Housing added 2026-10-30 once the user supplied them
 * directly). Several real lenders returned by Finfinity's
 * actual getcustomeroffers (confirmed live, 2026-10-16) are a specific arm/subsidiary with no logo
 * of its own — those reuse the parent brand's mark, the closest real asset available: Bajaj Housing
 * Finance -> Bajaj group, Tata Capital Housing -> Tata Capital, ICICI HFC -> ICICI Bank, PNB
 * Housing -> PNB Housing Finance, Jio Credit Limited -> Jio Financial Services, Piramal Housing ->
 * Piramal Finance, Aditya Birla Housing Finance -> Aditya Birla Group.
 *
 * Personal Loan's real financerwiseeligibility chain (2026-10-21, switched on) returns 13 lenders
 * with its own naming — several keys above are aliases for the exact same lender spelled
 * differently there (Poonawalla Fincorp Limited, Unity Bank, Kotak Bank, IDFC Bank, Piramal). Bajaj
 * Finserv/IndusInd Bank/Chola (Cholamandalam)/Hero Fincorp are new logos added for this chain,
 * sourced directly from each company's own Wikipedia infobox image; Fullerton/Poonawala/Tata
 * Capital/Unity Small Finance Bank came from each company's own official site instead (2026-10-21 —
 * the old Poonawala/Tata/Unity assets were solid-color square tiles designed for the old
 * crop-to-circle badge; once that badge switched to "contain, don't crop" for Personal Loan's wide
 * wordmark logos, those three looked boxed-in/wrong, so they were replaced with cleaner official
 * ones at the same time). */
// Values are filenames only (not imports) — the actual image files live in test-page/assets/lenders/
// on the server, served statically and fetched by ABSOLUTE url (see logoHtml below). They used to be
// imported here and inlined as base64 straight into this JS bundle, which alone made the bundle
// ~6.9MB (security-review finding, 2026-11-02) — a relative path wouldn't work here since this
// widget's HTML gets injected into an arbitrary partner's page, so any image url has to be absolute
// against our own API server, never relative to wherever the script happens to be embedded.
const LENDER_LOGOS: Record<string, string> = {
  'Poonawala Fincorp': 'poonawala-fincorp.svg',
  // Personal Loan's real financerwiseeligibility chain spells this one differently (2026-10-21) —
  // "Poonawalla" (double L) + "Limited" suffix, same lender, same logo.
  'Poonawalla Fincorp Limited': 'poonawala-fincorp.svg',
  'Tata Capital': 'tata-capital.svg',
  'Tata Capital Housing': 'tata-capital.svg',
  'Unity Small Finance Bank': 'unity-small-finance-bank.png',
  'Unity Bank': 'unity-small-finance-bank.png',
  'HDFC Bank': 'hdfc-bank.png',
  'ICICI Bank': 'icici-bank.png',
  'ICICI HFC': 'icici-bank.png',
  'SBI Home Loans': 'sbi-home-loans.png',
  // Confirmed 2026-10-31 that Home Loan's own HL_LENDER_DISPLAY_NAME map (used for our own BRE
  // comparison against the exact same real lender, homeLoanEligibility.service.ts) spells this one
  // 'State Bank of India', not 'SBI Home Loans' — the real getcustomeroffers chain apparently uses
  // that full name too, which never matched the only key that existed here, so it silently fell
  // back to the initials circle instead of the real logo. 'SBI' added too as a cheap extra guard in
  // case a shorter form shows up somewhere.
  'State Bank of India': 'sbi-home-loans.png',
  'SBI': 'sbi-home-loans.png',
  // Karur Vysya — had no logo asset or map entry at all before 2026-10-31 (same report); same
  // HL_LENDER_DISPLAY_NAME map confirms the real display name is exactly 'Karur Vysya'. Logo
  // sourced from the bank's own Wikipedia infobox image, same precedent as the other logos above.
  'Karur Vysya': 'karur-vysya-bank.svg',
  'Karur Vysya Bank': 'karur-vysya-bank.svg',
  'Axis Bank': 'axis-bank.png',
  'Kotak Mahindra Bank': 'kotak-mahindra-bank.png',
  'Kotak Bank': 'kotak-mahindra-bank.png',
  'Bajaj Housing Finance': 'bajaj-housing-finance.png',
  'Bajaj Finserv': 'bajaj-finserv.svg',
  'LIC Housing Finance': 'lic-housing-finance.png',
  'PNB Housing Finance': 'pnb-housing-finance.png',
  'PNB Housing': 'pnb-housing-finance.png',
  'Federal Bank': 'federal-bank.png',
  'HSBC': 'hsbc.png',
  'Jio Credit Limited': 'jio-credit.png',
  'RBL Bank': 'rbl-bank.png',
  'IDFC First Bank': 'idfc-first-bank.png',
  'IDFC Bank': 'idfc-first-bank.png',
  'IIFL': 'iifl.png',
  'Piramal Housing': 'piramal-finance.png',
  // Added 2026-10-30 — the user supplied these 3 directly, previously the only confirmed-missing
  // logos (see the comment above this map); exact display-name strings confirmed from
  // FINFINITY-BRE-MAIN/hl-eligibility-precheck's lenders-data (L&T/Aadhar) and
  // server/src/services/personalLoanEligibility.service.ts + flows/goldLoan.ts (Muthoot).
  'L&T Housing Finance': 'lt-housing-finance.png',
  'Aadhar Housing': 'aadhar-housing-finance.jpg',
  'Muthoot Finance': 'muthoot-finance.png',
  'Piramal Finance': 'piramal-finance.png',
  'Piramal': 'piramal-finance.png',
  'Aditya Birla Housing Finance': 'aditya-birla.png',
  'Aditya Birla Finance': 'aditya-birla.png',
  'IndusInd Bank': 'indusind-bank.svg',
  'Chola': 'cholamandalam.svg',
  'Hero Fincorp': 'hero-fincorp.svg',
  // Fullerton India rebranded to SMFG India Credit (2021, after SMBC/Sumitomo Mitsui acquired it) —
  // same company the real chain's "Fullerton" name still refers to, so its current official logo is
  // the accurate one to show, sourced directly from smfgindiacredit.com's own site header.
  'Fullerton': 'fullerton.svg',
};

function logoHtml(name: string, apiBase: string): string {
  const logo = LENDER_LOGOS[name];
  return logo ? `<img src="${apiBase}/assets/lenders/${logo}" alt="${name}" />` : initials(name);
}

/** Replaces the lender list once an offer's selected (see wireSelectOfferButtons in app.ts) —
 * used by Personal Loan (one lender card survives, replaced in place) and Home Loan/LAP (the whole
 * accordion list is replaced by this single card) alike. Logo sits in its own white badge (not the
 * circular avatar the live offer cards use) so a wide wordmark logo — most real lender logos are
 * lockups, not icons — renders in full instead of being cropped by a circle. */
export function lenderThankYouHtml(lenderName: string, apiBase: string, rmName?: string): string {
  return `
    <div class="lc-offer-thank-you">
      <div class="lc-offer-thank-you-logo">${logoHtml(lenderName, apiBase)}</div>
      <div class="lc-offer-thank-you-text">
        <div class="lc-offer-thank-you-title">You're all set with <strong>${lenderName}</strong></div>
        <div class="lc-offer-thank-you-sub">${rmName ?? 'Our relationship manager'} will reach out to you shortly.</div>
      </div>
    </div>`;
}

/** amountLakh is always in lakhs from the server — switch to crore above 100 lakh so "3000 lakh"
 * reads as "30 Cr" the way anyone would actually say it. */
function formatAmount(amountLakh: number, unitWord: 'short' | 'full' = 'short'): string {
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (amountLakh >= 100) {
    const cr = amountLakh / 100;
    return `₹${trim(cr)} ${unitWord === 'full' ? 'crore' : 'Cr'}`;
  }
  // Below ₹10,000 (0.1 lakh), "lakh" rounded to one decimal reads as a misleading "₹0.0 lakh" —
  // small gold-loan amounts in particular can genuinely be this small, so show plain rupees instead.
  if (amountLakh > 0 && amountLakh < 0.1) {
    return `₹${Math.round(amountLakh * 100_000).toLocaleString('en-IN')}`;
  }
  return `₹${trim(amountLakh)} ${unitWord === 'full' ? 'lakh' : 'L'}`;
}

export function rmCardHtml(rm: EligibilityResultPayload['rm'], leadId?: string): string {
  return `
    <div class="lc-rm-card" id="lc-rm-card">
      <div class="lc-rm-avatar">${initials(rm.name)}</div>
      <div>
        <div class="lc-rm-name">${rm.name} · your relationship manager</div>
        <div class="lc-rm-meta">${rm.phone} · ${rm.email}</div>
        ${leadId ? `<div class="lc-rm-meta">Lead ID: ${leadId}</div>` : ''}
      </div>
    </div>`;
}

const DISCLAIMER = `<div class="lc-disclaimer">Eligibility, interest rate, processing fee, and other charges shown are tentative and based on the details provided. Final eligibility and terms are subject to each lender's verification and credit policy, and may differ from what is displayed here.</div>`;

function minimizeBarHtml(): string {
  return `<button class="lc-min-bar" id="lc-btn-minimize" type="button">${ICON.minimize} Minimize</button>`;
}

/** The compact pill shown after minimizing — tapping it re-expands the full card. Kept in the DOM
 * (just hidden) rather than rebuilt, so re-expanding doesn't need another server round-trip. */
function collapsedPillHtml(result: EligibilityResultPayload): string {
  const best = result.offers?.[0];
  const label = result.eligible && best ? `Eligible for ${formatAmount(best.amountLakh, 'full')} — tap to view` : 'Not eligible right now — tap to view';
  return `<button class="lc-result-pill" id="lc-result-pill" type="button" style="display:none">${ICON.check}<span>${label}</span></button>`;
}

/** Gold loan only — a clickable "submit this application to the top lender" card, shown right
 * after the lead-created message. Deliberately leaves out EMI (per spec) and has no real backend
 * behind "submit" yet — clicking it just swaps it for a confirmation message (see
 * wireGoldSubmitCard in app.ts). Fees has no real data source yet either; shown as a placeholder
 * range for visual completeness, same "dummy for now" spirit as the rest of Gold loan's eligibility. */
function goldSubmitCardHtml(best: LenderOffer, apiBase: string, isEstimate?: boolean): string {
  return `
    <button class="lc-gold-submit-card" id="lc-gold-submit-card" type="button" data-lender="${best.name}" data-amount-lakh="${best.amountLakh}">
      <div class="lc-gold-submit-top">
        <div class="lc-gold-submit-logo">${logoHtml(best.name, apiBase)}</div>
        <div class="lc-gold-submit-lender">${best.name}</div>
        ${isEstimate ? '<span class="lc-best-tag">Estimate</span>' : ''}
      </div>
      <!-- Submit button moved onto the same line as the amount (2026-11-02 direct instruction —
           was its own centered line below the stats grid, which read as floating far away from
           the amount it's actually tied to). -->
      <div class="lc-gold-submit-main">
        <div class="lc-gold-submit-amount-block">
          <div class="lc-gold-submit-amount">Upto ${formatAmount(best.amountLakh, 'full')}</div>
          <div class="lc-gold-submit-rate">Starting ${best.rate}%</div>
        </div>
        <div class="lc-gold-submit-cta">Submit to ${best.name}</div>
      </div>
      <div class="lc-gold-submit-grid">
        <div class="lc-gold-stat"><span class="lc-gold-stat-k">Tenure:</span><span class="lc-gold-stat-v">${best.tenureYears * 12} months</span></div>
        <div class="lc-gold-stat"><span class="lc-gold-stat-k">Fees:</span><span class="lc-gold-stat-v">0.25% to 2%</span></div>
      </div>
      ${isEstimate ? '<div class="lc-gold-submit-estimate-note">Based on the gold details you provided — your final amount and rate are confirmed after physical verification.</div>' : ''}
    </button>`;
}

/** Loan Against Securities and Business Loan both have no eligibility/offers at all (direct
 * instruction, 2026-10-16 for Business Loan) — just a lead confirmation and the RM card, same
 * minimal spirit as Gold Loan's card but without even a submit-to-lender step. */
// Shared by Business Loan and LAS (renderResultCard below) — neither ever computes eligibility,
// an interest rate, or a processing fee at all (both lead-only, no real BRE exists yet for either
// — see businessLoan.ts/loanAgainstShares.ts's own doc comments), so the generic disclaimer about
// those exact things being "tentative" was just misleading here, not cautious (2026-10-21 — removed
// for both; first removed for Business Loan alone, then LAS on the same reasoning).
function renderLasResultCard(result: EligibilityResultPayload): string {
  return `
    <div id="lc-result-expanded">
      <div class="lc-badge">${ICON.check} Application received</div>
      ${rmCardHtml(result.rm, result.leadId)}
      <div id="lc-pan-offer"></div>
      <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
    </div>
  `;
}

/** Gold loan's result is deliberately NOT the generic eligibility-card layout (no "eligibility
 * check complete" badge, no sanction block, no per-lender list, no collapse/minimize) — just the
 * one lender's submit card, and the RM card below it. There's only ever one lender (Muthoot) for
 * gold loan, so the usual "compare across lenders" framing doesn't apply here at all. */
function renderGoldResultCard(result: EligibilityResultPayload, apiBase: string): string {
  const best = result.offers?.[0];

  if (!result.eligible || !best) {
    return `
      <div id="lc-result-expanded">
        <div class="lc-not-eligible">
          <div class="lc-not-eligible-title">No eligibility for this profile right now</div>
          <div class="lc-not-eligible-text">Based on the details provided, we couldn't find a lender offer for you at this time. Updating your details, or checking again later, may change this.</div>
        </div>
        ${rmCardHtml(result.rm, result.leadId)}
        <div id="lc-pan-offer"></div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  return `
    <div id="lc-result-expanded">
      <div id="lc-gold-submit-slot">${goldSubmitCardHtml(best, apiBase, result.isEstimate)}</div>
      ${rmCardHtml(result.rm, result.leadId)}
      <div id="lc-pan-offer"></div>
      ${DISCLAIMER}
      <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
    </div>
  `;
}

/** One lender's offer, styled as a big light card (same visual language as Gold loan's submit
 * card — see goldSubmitCardHtml) instead of the compact click-to-expand row the other products
 * use. Purely informational here (no "tap to submit" — Personal loan has three lenders to
 * compare, not one to act on), so EMI/tenure are shown directly rather than behind an accordion. */
/** Same collapsible accordion row as Home Loan's .la-lender list (2026-10-30 — previously a
 * permanently-expanded "big card" per lender, a deliberate choice when Personal Loan only ever
 * showed 3 lenders; now that it can show many more, the generic accordion is more consistent and
 * less overwhelming, matching every other product). */
function personalLoanLenderCardHtml(o: LenderOffer, isBest: boolean, apiBase: string): string {
  const totalPayable = o.emi * o.tenureYears * 12;
  const totalInterest = Math.max(0, totalPayable - o.amountLakh * 100000);
  return `
    <details class="la-lender" data-pl-lender-card="${o.name}">
      <summary>
        <span class="la-bank-icon" aria-hidden="true">${logoHtml(o.name, apiBase)}</span>
        <span><strong>${o.name}</strong><small>${o.rate}% p.a. · ${o.tenureYears} yr tenure</small></span>
        <span><strong>${formatAmount(o.amountLakh)}</strong><small>EMI ₹${o.emi.toLocaleString('en-IN')}/mo</small></span>
        ${isBest ? '<span class="la-tag lc-pl-best-tag">Best offer</span>' : ''}
      </summary>
      <div class="la-lender-body">
        <div class="la-eyebrow">${o.name} — Full breakdown</div>
        <div class="la-amount">${formatAmount(o.amountLakh, 'full')}</div>
        <p class="la-small">at ${o.rate}% p.a. over ${o.tenureYears} years</p>
        <div class="la-result-grid">
          <div><small>Monthly EMI</small><strong>₹${o.emi.toLocaleString('en-IN')}</strong></div>
          <div><small>Tenure</small><strong>${o.tenureYears} years</strong></div>
          <div><small>Total payable</small><strong>₹${Math.round(totalPayable).toLocaleString('en-IN')}</strong></div>
          <div><small>Total interest</small><strong>₹${Math.round(totalInterest).toLocaleString('en-IN')}</strong></div>
        </div>
        <div class="lc-select-offer-slot" data-select-offer-slot="${o.name}">
          <button class="la-primary" type="button" data-select-offer="${o.name}">Select this offer</button>
        </div>
      </div>
    </details>`;
}

/** Personal loan: a compact headline (no Product/Loan type/CIBIL/Segment grid — those are the
 * same for every lender here, so listing them per-check added nothing) followed by the three
 * lenders as big cards, not the generic accordion-row list. */
function renderPersonalLoanResultCard(result: EligibilityResultPayload, apiBase: string): string {
  const offers = result.offers ?? [];
  const best = offers[0];

  if (!result.eligible || !best) {
    return `
      <div id="lc-result-expanded">
        <div class="lc-not-eligible">
          <div class="lc-not-eligible-title">No eligibility for this profile right now</div>
          <div class="lc-not-eligible-text">Based on the income, EMI, and other details provided, we couldn't find a lender offer for you at this time. Updating your income or EMI details, or checking again later, may change this.</div>
        </div>
        ${rmCardHtml(result.rm, result.leadId)}
        <div id="lc-pan-offer"></div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  // Bug fixed 2026-11-02 ("selected offer vanishes on reload"): once an offer's actually been
  // picked (persisted server-side, see select-offer's payload.selectedLenderName), jump straight to
  // the thank-you state instead of the full compare-lenders view — otherwise a page reload looked
  // like nothing had been selected and asked the customer to pick again.
  if (result.selectedLenderName) {
    return `
      <div id="lc-result-expanded">
        <div class="lc-badge">${ICON.check} Eligibility check complete</div>
        ${lenderThankYouHtml(result.selectedLenderName, apiBase, result.rm?.name)}
        ${rmCardHtml(result.rm, result.leadId)}
        <div id="lc-pan-offer"></div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  return `
    <div id="lc-result-expanded">
      <div class="lc-badge">${ICON.check} Eligibility check complete</div>
      <div class="lc-sanction" id="lc-pl-highest-eligibility">
        <div class="lc-sanction-header">
          <div class="lc-eyebrow">Highest eligibility</div>
          <div class="lc-sanction-logo">${logoHtml(best.name, apiBase)}</div>
        </div>
        <div class="lc-amount">Upto ${formatAmount(best.amountLakh, 'full')}</div>
        <div class="lc-amount-note">with ${best.name}, interest starting from ${best.rate}% p.a. over ${best.tenureYears} years</div>
      </div>

      <div class="lc-field-label" style="margin-top:14px">Eligibility by lender</div>
      <div class="lc-lender-list">
        ${offers.map((o, i) => personalLoanLenderCardHtml(o, i === 0, apiBase)).join('')}
      </div>

      ${rmCardHtml(result.rm, result.leadId)}
      <div id="lc-pan-offer"></div>
      ${DISCLAIMER}
      <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
    </div>
  `;
}

export function renderResultCard(result: EligibilityResultPayload, apiBase: string): string {
  // Segment-gated products stop before any product questions were ever asked — Business Loan
  // excludes salaried applicants (2026-10-17), Personal Loan excludes non-salaried ones
  // (2026-10-21, its real lender eligibility rules only apply to salaried applicants) — so there's
  // no real lead/RM/offers behind this either way. Checked before the per-product branches below,
  // since those assume there IS eligibility data to show.
  if (result.segmentNotSupported) {
    const reason =
      result.product === 'Personal Loan'
        ? 'This product is only available for salaried applicants.'
        : 'This product is only available for business owners and self-employed professionals.';
    return `
      <div id="lc-result-expanded">
        <div class="lc-badge lc-badge-muted">${ICON.info} Not available for this profile</div>
        <div class="lc-not-eligible">
          <div class="lc-not-eligible-title">${result.product} isn't available for this profile</div>
          <div class="lc-not-eligible-text">${reason}</div>
        </div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  if (result.product === 'Gold Loan') return renderGoldResultCard(result, apiBase);
  if (result.product === 'Personal Loan') return renderPersonalLoanResultCard(result, apiBase);
  if (result.product === 'Loan Against Securities') return renderLasResultCard(result);
  // Business Loan never computes eligibility/offers (2026-10-16 direct instruction: "we never
  // calculate eligibility, just capture lead") — same lead-only card as LAS, except when the entity
  // gate below stopped the flow before a lead ever existed.
  if (result.product === 'Business Loan' && !result.entityNotSupported) return renderLasResultCard(result);

  // Home Loan/LAP only, non-individual PAN — no income/property questions were even asked (see
  // flows/homeLoan.ts's isIndividualPan), so there's no real lead/RM behind this either; a plain
  // explanatory message, not the generic "no eligibility" copy which would wrongly suggest trying
  // again with different numbers could help.
  if (result.entityNotSupported) {
    return `
      <div id="lc-result-expanded">
        <div class="lc-badge lc-badge-muted">${ICON.info} Entities not supported yet</div>
        <div class="lc-not-eligible">
          <div class="lc-not-eligible-title">We don't have a journey for entities yet</div>
          <div class="lc-not-eligible-text">This product is currently only available for individual applicants. Support for companies, firms/LLPs, and other entity types is coming soon.</div>
        </div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  if (!result.eligible) {
    return `
      ${collapsedPillHtml(result)}
      <div id="lc-result-expanded">
        ${minimizeBarHtml()}
        <div class="lc-not-eligible">
          <div class="lc-not-eligible-title">No eligibility for this profile right now</div>
          <div class="lc-not-eligible-text">Based on the income, EMI, and other details provided, we couldn't find a lender offer for you at this time. Updating your income or EMI details, or checking again later, may change this.</div>
        </div>
        ${rmCardHtml(result.rm, result.leadId)}
        <div id="lc-pan-offer"></div>
        ${DISCLAIMER}
        <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
      </div>
    `;
  }

  // Bug fixed 2026-11-02 ("selected offer vanishes on reload"): same fix as Personal Loan above —
  // once an offer's actually been picked (persisted server-side), jump straight to the thank-you
  // state instead of the full compare-lenders view on every later render/reload.
  if (result.selectedLenderName) {
    return `
      <section id="lc-result-expanded" class="la-results">
        <div class="la-tag">Eligibility check complete</div>
        <h2>Your loan eligibility</h2>
        <button class="lc-min-bar" id="lc-btn-minimize" type="button" aria-label="Minimize" aria-expanded="true">Minimize</button>
        ${lenderThankYouHtml(result.selectedLenderName, apiBase, result.rm?.name)}
        ${rmCardHtml(result.rm, result.leadId)}
        <div id="lc-pan-offer"></div>
        <p class="la-small" id="lc-disclaimer">Eligibility, interest rate, processing fee, and other charges shown are tentative and based on the details provided. Final eligibility and terms are subject to each lender's verification and credit policy, and may differ from what is displayed here.</p>
        <button class="lc-ghost-btn" id="lc-btn-restart" type="button">Start a new check</button>
      </section>
    `;
  }

  const offers = result.offers ?? [];
  const best = offers[0];
  // The property cap (when a property value is known) becomes the headline; the pure
  // income-based figure is always shown too, but only needs a distinct stat when it differs from
  // the headline (i.e. once a property is in the picture) — see the user-facing spec: "if the
  // property is not selected then we will only show financial eligibility."
  const headlineLakh = result.propertyCappedEligibilityLakh ?? best?.amountLakh;
  const showFinancialStat = result.propertyCappedEligibilityLakh !== undefined && result.financialEligibilityLakh !== undefined;

  // CIS's exact "la-results"/"la-lender" markup (captured verbatim from personal-suite-updated.html's
  // live results screen, 2026-10-28 "ship it 1:1" pass) — same classes, same structure, same
  // collapse mechanic (a single la-link toggles `hidden` across the children + a `data-collapsed`
  // attribute, rather than our old separate pill/expanded-block pair; see wireResultMinimize in
  // app.ts). The only departures from CIS's literal source text are the "· Preview"/"Sample"/
  // "Illustrative" qualifiers their static demo used (no real backend behind it) — dropped since
  // this is the real, live eligibility check, not a preview. Lender rows use CIS's own generic
  // bank-icon glyph, not our real per-lender logos, to match their design exactly.
  return `
    <section id="lc-result-expanded" class="la-results">
      <div class="la-tag">Eligibility check complete</div>
      <h2>Your loan eligibility</h2>
      <!-- CIS's own captured design used a plain underlined text link (.la-link) here — changed to
           the same big pill style as the not-eligible card's minimize button per direct instruction
           (2026-10-31: "this minimise button dawg"), for a bigger, more visible toggle. No icon
           (unlike .lc-min-bar's other use) — wireResultMinimize's toggle sets this button's
           textContent directly on every click, which would silently wipe out an inline icon. -->
      <button class="lc-min-bar" id="lc-btn-minimize" type="button" aria-label="Minimize" aria-expanded="true">Minimize</button>
      ${
        best && headlineLakh !== undefined
          ? `<div class="la-estimate" id="lc-highest-eligibility">
        <div class="la-eyebrow">Highest eligibility (property-capped where applicable)</div>
        <div class="la-amount">${formatAmount(headlineLakh, 'full')}</div>
        <p class="la-small">${best.name} estimate at ${best.rate}% p.a. over ${best.tenureYears} years.</p>
        <div class="la-result-grid">
          <div><small>Product</small><strong>${result.product}</strong></div>
          <div><small>Loan type</small><strong>${result.loanType}</strong></div>
          ${result.creditScore ? `<div><small>CIBIL score</small><strong>${result.creditScore}</strong></div>` : ''}
          ${result.segment ? `<div><small>Segment</small><strong>${result.segment}</strong></div>` : ''}
          ${result.propertyType ? `<div><small>Property type</small><strong>${result.propertyType}</strong></div>` : ''}
          ${result.collateralType ? `<div><small>Collateral type</small><strong>${result.collateralType}</strong></div>` : ''}
          ${result.occupancy ? `<div><small>Occupancy</small><strong>${result.occupancy}</strong></div>` : ''}
          ${result.propertyValueLakh ? `<div><small>Property value</small><strong>${formatAmount(result.propertyValueLakh)}</strong></div>` : ''}
          ${showFinancialStat ? `<div><small>Financial eligibility</small><strong>${formatAmount(result.financialEligibilityLakh!)}</strong></div>` : ''}
        </div>
      </div>`
          : ''
      }

      <p class="la-small" id="lc-eligibility-by-lender-label">Eligibility by lender</p>
      <div id="lc-lender-list">
        ${offers
          .map((o) => {
            const totalPayable = o.emi * o.tenureYears * 12;
            const totalInterest = Math.max(0, totalPayable - o.amountLakh * 100000);
            return `
          <details class="la-lender">
            <summary>
              <span class="la-bank-icon" aria-hidden="true">${logoHtml(o.name, apiBase)}</span>
              <span><strong>${o.name}</strong><small>${o.rate}% p.a. · ${o.tenureYears} yr tenure</small></span>
              <span><strong>${formatAmount(o.amountLakh)}</strong><small>EMI ₹${o.emi.toLocaleString('en-IN')}/mo</small></span>
            </summary>
            <div class="la-lender-body">
              <div class="la-eyebrow">${o.name} — Full breakdown</div>
              <div class="la-amount">${formatAmount(o.amountLakh, 'full')}</div>
              <p class="la-small">at ${o.rate}% p.a. over ${o.tenureYears} years</p>
              <div class="la-result-grid">
                <div><small>Monthly EMI</small><strong>₹${o.emi.toLocaleString('en-IN')}</strong></div>
                <div><small>Tenure</small><strong>${o.tenureYears} years</strong></div>
                <div><small>Total payable</small><strong>₹${Math.round(totalPayable).toLocaleString('en-IN')}</strong></div>
                <div><small>Total interest</small><strong>₹${Math.round(totalInterest).toLocaleString('en-IN')}</strong></div>
              </div>
              <div class="lc-select-offer-slot" data-select-offer-slot="${o.name}">
                <button class="la-primary" type="button" data-select-offer="${o.name}">Select this offer</button>
              </div>
            </div>
          </details>`;
          })
          .join('')}
      </div>

      ${rmCardHtml(result.rm, result.leadId)}
      <div id="lc-gold-submit-slot">${result.product === 'Gold Loan' && result.leadCreated && best ? goldSubmitCardHtml(best, apiBase, result.isEstimate) : ''}</div>
      <div id="lc-pan-offer"></div>
      <p class="la-small" id="lc-disclaimer">Eligibility, interest rate, processing fee, and other charges shown are tentative and based on the details provided. Final eligibility and terms are subject to each lender's verification and credit policy, and may differ from what is displayed here.</p>
      <button class="lc-ghost-btn" id="lc-btn-restart" type="button">Start a new check</button>
    </section>
  `;
}
