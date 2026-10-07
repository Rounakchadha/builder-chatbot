import type { EligibilityResultPayload } from '@loan-chatbot/shared';
import { ICON } from './icons';

function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

/** amountLakh is always in lakhs from the server — switch to crore above 100 lakh so "3000 lakh"
 * reads as "30 Cr" the way anyone would actually say it. */
function formatAmount(amountLakh: number, unitWord: 'short' | 'full' = 'short'): string {
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (amountLakh >= 100) {
    const cr = amountLakh / 100;
    return `₹${trim(cr)} ${unitWord === 'full' ? 'crore' : 'Cr'}`;
  }
  return `₹${trim(amountLakh)} ${unitWord === 'full' ? 'lakh' : 'L'}`;
}

function rmCardHtml(rm: EligibilityResultPayload['rm'], leadId?: string): string {
  return `
    <div class="lc-rm-card">
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

export function renderResultCard(result: EligibilityResultPayload): string {
  if (!result.eligible) {
    return `
      ${collapsedPillHtml(result)}
      <div id="lc-result-expanded">
        ${minimizeBarHtml()}
        <div class="lc-badge lc-badge-muted">${ICON.info} Eligibility check complete</div>
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

  const offers = result.offers ?? [];
  const best = offers[0];
  // The property cap (when a property value is known) becomes the headline; the pure
  // income-based figure is always shown too, but only needs a distinct stat when it differs from
  // the headline (i.e. once a property is in the picture) — see the user-facing spec: "if the
  // property is not selected then we will only show financial eligibility."
  const headlineLakh = result.propertyCappedEligibilityLakh ?? best?.amountLakh;
  const showFinancialStat = result.propertyCappedEligibilityLakh !== undefined && result.financialEligibilityLakh !== undefined;

  return `
    ${collapsedPillHtml(result)}
    <div id="lc-result-expanded">
      ${minimizeBarHtml()}
      <div class="lc-badge">${ICON.check} Eligibility check complete</div>
      ${
        best && headlineLakh !== undefined
          ? `<div class="lc-sanction">
        <div class="lc-eyebrow">${result.propertyCappedEligibilityLakh !== undefined ? 'Highest eligibility (property-capped)' : 'Highest eligibility'}</div>
        <div class="lc-amount">${formatAmount(headlineLakh, 'full')}</div>
        <div class="lc-amount-note">with ${best.name}, at ${best.rate}% p.a. over ${best.tenureYears} years</div>
        <div class="lc-grid">
          <div><span class="lc-k">Product</span><span class="lc-v">${result.product}</span></div>
          <div><span class="lc-k">Loan type</span><span class="lc-v">${result.loanType}</span></div>
          ${result.creditScore ? `<div><span class="lc-k">CIBIL score</span><span class="lc-v">${result.creditScore}</span></div>` : ''}
          ${result.segment ? `<div><span class="lc-k">Segment</span><span class="lc-v">${result.segment}</span></div>` : ''}
          ${result.propertyType ? `<div><span class="lc-k">Property type</span><span class="lc-v">${result.propertyType}</span></div>` : ''}
          ${result.collateralType ? `<div><span class="lc-k">Collateral type</span><span class="lc-v">${result.collateralType}</span></div>` : ''}
          ${result.occupancy ? `<div><span class="lc-k">Occupancy</span><span class="lc-v">${result.occupancy}</span></div>` : ''}
          ${result.propertyValueLakh ? `<div><span class="lc-k">Property value</span><span class="lc-v">${formatAmount(result.propertyValueLakh)}</span></div>` : ''}
          ${showFinancialStat ? `<div><span class="lc-k">Financial eligibility</span><span class="lc-v">${formatAmount(result.financialEligibilityLakh!)}</span></div>` : ''}
        </div>
      </div>`
          : ''
      }

      <div class="lc-field-label" style="margin-top:14px">Eligibility by lender</div>
      <div class="lc-lender-list">
        ${offers
          .map((o, i) => {
            const totalPayable = o.emi * o.tenureYears * 12;
            const totalInterest = Math.max(0, totalPayable - o.amountLakh * 100000);
            return `
          <button class="lc-lender-row ${i === 0 ? 'lc-best' : ''}" type="button" data-lender-toggle="${i}" style="animation-delay:${i * 45}ms">
            <div>
              ${i === 0 ? '<span class="lc-best-tag">Best offer</span>' : ''}
              <span class="lc-lender-name">${o.name}</span>
              <span class="lc-lender-rate">${o.rate}% p.a. · ${o.tenureYears} yr tenure</span>
            </div>
            <div class="lc-lender-row-right">
              <div>
                <div class="lc-lender-amount">${formatAmount(o.amountLakh)}</div>
                <div class="lc-lender-emi">EMI ₹${o.emi.toLocaleString('en-IN')}/mo</div>
              </div>
              <span class="lc-lender-chevron">${ICON.chevronDown}</span>
            </div>
          </button>
          <div class="lc-lender-detail lc-sanction" id="lc-lender-detail-${i}" style="display:none">
            <div class="lc-eyebrow">${o.name} — full breakdown</div>
            <div class="lc-amount">${formatAmount(o.amountLakh, 'full')}</div>
            <div class="lc-amount-note">at ${o.rate}% p.a. over ${o.tenureYears} years</div>
            <div class="lc-grid">
              <div><span class="lc-k">Monthly EMI</span><span class="lc-v">₹${o.emi.toLocaleString('en-IN')}</span></div>
              <div><span class="lc-k">Tenure</span><span class="lc-v">${o.tenureYears} years</span></div>
              <div><span class="lc-k">Total payable</span><span class="lc-v">₹${Math.round(totalPayable).toLocaleString('en-IN')}</span></div>
              <div><span class="lc-k">Total interest</span><span class="lc-v">₹${Math.round(totalInterest).toLocaleString('en-IN')}</span></div>
            </div>
          </div>`;
          })
          .join('')}
      </div>

      ${rmCardHtml(result.rm, result.leadId)}
      <div id="lc-pan-offer"></div>
      ${DISCLAIMER}
      <button class="lc-ghost-btn" id="lc-btn-restart">Start a new check</button>
    </div>
  `;
}
