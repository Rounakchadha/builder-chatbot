import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { lenderNamesMatch, reasonsOverlap } from '../flows/personalLoan';
import { LENDER_DISPLAY_NAME, type PlEligibilityFacts } from '../services/personalLoanEligibility.service';
import { HL_LENDER_DISPLAY_NAME, type HlEligibilityFacts } from '../services/homeLoanEligibility.service';

/** Internal-only reporting pages — not part of the customer-facing API, gated by a plain shared
 * secret rather than full auth (see ADMIN_TOKEN in config/env.ts). */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/pl-bre-comparison', async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
    if (!checkAdminAuth(req)) return reply.code(401).type('text/plain').send('Unauthorized — pass ?token=... or an x-admin-token header.');

    const rows = await prisma.plBreComparison.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500, // no real pagination yet — fine at today's volume, revisit if this table grows large
    });

    return reply.type('text/html').send(renderReport(rows));
  });

  app.get('/admin/hl-bre-comparison', async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
    if (!checkAdminAuth(req)) return reply.code(401).type('text/plain').send('Unauthorized — pass ?token=... or an x-admin-token header.');

    const rows = await prisma.hlBreComparison.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500, // no real pagination yet — fine at today's volume, revisit if this table grows large
    });

    return reply.type('text/html').send(renderHlReport(rows));
  });
}

/** Dev: no token configured means no auth at all, for quick local iteration. Anywhere else: an
 * unset ADMIN_TOKEN refuses every request outright rather than leaving this silently open (same
 * fail-closed spirit as config/env.ts's assertProductionSafe). */
function checkAdminAuth(req: FastifyRequest<{ Querystring: { token?: string } }>): boolean {
  if (!env.ADMIN_TOKEN) return env.NODE_ENV === 'development';
  const supplied = req.query?.token || (req.headers['x-admin-token'] as string | undefined);
  return supplied === env.ADMIN_TOKEN;
}

/** One lender's outcome, shape-normalized — new rows store PlLenderComparisonResult[] (lender/
 * eligible/reasons/...), but the 4 rows that existed before 2026-10-24's migration still hold the
 * old approved-only LenderOffer[] shape (name/amountLakh/...) under the same (renamed) columns.
 * Treating an old-shape entry as "eligible, no reason recorded" keeps the report from crashing on
 * them instead of requiring a backfill. */
interface NormalizedResult {
  lender: string;
  eligible: boolean;
  reasons: string[];
  amountLakh?: number;
  rate?: string;
}
function normalizeResults(json: unknown): NormalizedResult[] {
  if (!Array.isArray(json)) return [];
  const out: NormalizedResult[] = [];
  for (const entry of json) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.lender === 'string' && typeof e.eligible === 'boolean') {
      out.push({
        lender: e.lender,
        eligible: e.eligible,
        reasons: Array.isArray(e.reasons) ? (e.reasons as string[]) : [],
        amountLakh: typeof e.amountLakh === 'number' ? e.amountLakh : undefined,
        rate: typeof e.rate === 'string' ? e.rate : undefined,
      });
    } else if (typeof e.name === 'string') {
      out.push({ lender: e.name, eligible: true, reasons: [], amountLakh: e.amountLakh as number | undefined, rate: e.rate as string | undefined });
    }
  }
  return out;
}

function findByLender(results: NormalizedResult[], displayName: string): NormalizedResult | undefined {
  return results.find((r) => lenderNamesMatch(r.lender, displayName));
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LENDER_DISPLAY_NAMES = Object.values(LENDER_DISPLAY_NAME);

function renderReport(rows: Array<{ id: string; conversationId: string; leadId: string | null; facts: unknown; realChainResults: unknown; ownBreResults: unknown; createdAt: Date }>): string {
  const parsed = rows.map((row) => ({
    ...row,
    facts: row.facts as Partial<PlEligibilityFacts>,
    real: normalizeResults(row.realChainResults),
    own: normalizeResults(row.ownBreResults),
  }));

  // ---- summary stats ----
  const total = parsed.length;
  const perLenderAgreement = LENDER_DISPLAY_NAMES.map((lender) => {
    let comparable = 0;
    let agree = 0;
    for (const row of parsed) {
      const real = findByLender(row.real, lender);
      const own = findByLender(row.own, lender);
      if (!real || !own) continue; // one side never attempted this lender (e.g. old-shape row) — not comparable
      comparable++;
      if (real.eligible === own.eligible) agree++;
    }
    return { lender, comparable, agree, pct: comparable ? Math.round((agree / comparable) * 100) : null };
  });

  let countMatchRows = 0;
  let countMatchTotal = 0;
  let reasonOverlapRows = 0;
  let reasonOverlapTotal = 0;
  for (const row of parsed) {
    if (row.real.length && row.own.length) {
      countMatchTotal++;
      if (row.real.filter((r) => r.eligible).length === row.own.filter((r) => r.eligible).length) countMatchRows++;
    }
    for (const lender of LENDER_DISPLAY_NAMES) {
      const real = findByLender(row.real, lender);
      const own = findByLender(row.own, lender);
      if (!real || !own || real.eligible || own.eligible) continue; // only "both rejected" pairs count here
      reasonOverlapTotal++;
      if (reasonsOverlap(real.reasons, own.reasons)) reasonOverlapRows++;
    }
  }

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}% (${n}/${d})` : 'n/a (no comparable rows)');
  const pctNum = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
  const tier = (p: number | null) => (p === null ? 'tier-na' : p >= 80 ? 'tier-good' : p >= 50 ? 'tier-mid' : 'tier-bad');

  const summaryCards = perLenderAgreement
    .map((l) => {
      const p = pctNum(l.agree, l.comparable);
      return `<div class="sum-card ${tier(p)}">
          <div class="sum-card-name">${esc(l.lender)}</div>
          <div class="sum-card-pct">${p === null ? '—' : `${p}%`}</div>
          <div class="sum-card-sub">${p === null ? 'no comparable rows' : `agree ${l.agree}/${l.comparable}`}</div>
        </div>`;
    })
    .join('');

  const overallP = pctNum(countMatchRows, countMatchTotal);
  const reasonP = pctNum(reasonOverlapRows, reasonOverlapTotal);
  const summaryHtml = `
    <div class="panel">
      <h2 class="panel-title">Summary <span class="muted">— ${total} customer${total === 1 ? '' : 's'} compared</span></h2>
      <div class="sum-grid">${summaryCards}</div>
      <div class="sum-footnotes">
        <div class="footnote"><span class="pill ${tier(overallP)}">${pct(countMatchRows, countMatchTotal)}</span> exact eligible-lender-count match</div>
        <div class="footnote"><span class="pill ${tier(reasonP)}">${pct(reasonOverlapRows, reasonOverlapTotal)}</span> shared-keyword reasons when both reject the same lender</div>
      </div>
    </div>`;

  const cell = (r: NormalizedResult | undefined) => {
    if (!r) return '<span class="dash">—</span>';
    if (r.eligible) {
      return `<div class="verdict verdict-yes">✓ ${esc(r.amountLakh ?? '?')}L <span class="rate">@ ${esc(r.rate ?? '?')}%</span></div>`;
    }
    const reason = r.reasons.length ? `<div class="reason" title="${esc(r.reasons.join('; '))}">${esc(r.reasons.join('; '))}</div>` : '';
    return `<div class="verdict verdict-no">✗ not eligible</div>${reason}`;
  };

  const rowsHtml = parsed
    .map((row, i) => {
      const factsSummary = `₹${esc(row.facts?.monthlyIncome ?? '?')}/mo · CIBIL ${esc(row.facts?.cibilScore ?? '?')} · age ${esc(row.facts?.age ?? '?')} · ${esc(row.facts?.pincode ?? '?')}`;
      const lenderCells = LENDER_DISPLAY_NAMES.map((lender) => {
        const real = findByLender(row.real, lender);
        const own = findByLender(row.own, lender);
        const disagree = Boolean(real && own && real.eligible !== own.eligible);
        return `<td class="lender-td${disagree ? ' disagree' : ''}">
            <div class="lender-name">${esc(lender)}</div>
            <div class="lender-split">
              <div class="lender-side"><div class="side-label">Bitsflow</div>${cell(real)}</div>
              <div class="lender-side"><div class="side-label">Ours</div>${cell(own)}</div>
            </div>
          </td>`;
      }).join('');
      return `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td class="meta-td date-td">${row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
          <td class="meta-td conv-td">${esc(row.conversationId.slice(0, 8))}…</td>
          <td class="meta-td facts-td">${esc(factsSummary)}</td>
          ${lenderCells}
        </tr>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>PL BRE Comparison — internal</title>
  <meta name="robots" content="noindex" />
  <style>
    :root {
      --bg: #0a0a0c;
      --surface: #141417;
      --surface-2: #1b1b1f;
      --border: #2a2a30;
      --ink: #e8e8ec;
      --ink-soft: #9a9aa3;
      --ink-faint: #6b6b74;
      --accent: #60a5fa;
      --good: #34d399;
      --good-soft: rgba(52, 211, 153, 0.12);
      --mid: #fbbf24;
      --mid-soft: rgba(251, 191, 36, 0.12);
      --bad: #f87171;
      --bad-soft: rgba(248, 113, 113, 0.14);
      --na-soft: rgba(255, 255, 255, 0.04);
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 28px;
      margin: 0;
    }
    h1 { font-size: 19px; font-weight: 650; margin: 0 0 20px; letter-spacing: -0.01em; }
    .muted { color: var(--ink-faint); font-weight: 400; }

    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; margin-bottom: 22px; }
    .panel-title { margin: 0 0 16px; font-size: 14.5px; font-weight: 600; }

    .sum-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .sum-card { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; border-left: 3px solid transparent; }
    .sum-card-name { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
    .sum-card-pct { font-size: 20px; font-weight: 700; line-height: 1; margin-bottom: 4px; }
    .sum-card-sub { font-size: 11px; color: var(--ink-faint); }
    .tier-good { border-left-color: var(--good); } .tier-good .sum-card-pct { color: var(--good); }
    .tier-mid  { border-left-color: var(--mid); }  .tier-mid .sum-card-pct  { color: var(--mid); }
    .tier-bad  { border-left-color: var(--bad); }  .tier-bad .sum-card-pct  { color: var(--bad); }
    .tier-na   { border-left-color: var(--ink-faint); } .tier-na .sum-card-pct { color: var(--ink-faint); }

    .sum-footnotes { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .footnote { font-size: 12.5px; color: var(--ink-soft); display: flex; align-items: center; gap: 8px; }
    .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-weight: 650; font-size: 11.5px; }
    .pill.tier-good { background: var(--good-soft); color: var(--good); border-left: none; }
    .pill.tier-mid  { background: var(--mid-soft);  color: var(--mid);  border-left: none; }
    .pill.tier-bad  { background: var(--bad-soft);  color: var(--bad);  border-left: none; }
    .pill.tier-na   { background: var(--na-soft);   color: var(--ink-faint); border-left: none; }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 1400px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--surface-2); color: var(--ink-soft);
      padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .row-even td { background: var(--surface); }
    .row-odd td { background: #111114; }
    tbody tr:hover td { background: #1c1c20; }

    .meta-td { white-space: nowrap; }
    .date-td { color: var(--ink-soft); font-size: 11.5px; }
    .conv-td { color: var(--ink-faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .facts-td { font-size: 11.5px; white-space: normal; min-width: 160px; }

    .lender-td { min-width: 180px; border-left: 1px solid var(--border); }
    .lender-td.disagree { background: var(--bad-soft) !important; }
    .lender-name { font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
    .lender-split { display: flex; gap: 12px; }
    .lender-side { flex: 1; min-width: 0; }
    .side-label { font-size: 9.5px; color: var(--ink-faint); margin-bottom: 2px; }
    .verdict { font-weight: 650; font-size: 12.5px; }
    .verdict-yes { color: var(--good); }
    .verdict-no { color: var(--bad); }
    .rate { font-weight: 500; color: var(--ink-soft); }
    .reason { color: var(--ink-faint); font-size: 10.5px; margin-top: 3px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .dash { color: var(--ink-faint); }
  </style>
</head>
<body>
  <h1>Personal Loan — BRE shadow-mode comparison</h1>
  ${summaryHtml}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Conversation</th>
          <th>Facts</th>
          ${LENDER_DISPLAY_NAMES.map((l) => `<th>${esc(l)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</body>
</html>`;
}

const HL_LENDER_DISPLAY_NAMES = Object.values(HL_LENDER_DISPLAY_NAME);

/** HL's realChainResults is ALWAYS the eligible-only shape (see HlBreComparison's schema comment
 * — getcustomeroffers's rejected_lender_list isn't threaded through at this layer), unlike PL's
 * normalizeResults which has to handle two historical shapes. So a lender's absence from
 * realChainResults means "real chain rejected it", not "not attempted" — we treat it as a known
 * false, never as incomparable, which is why this needs its own (simpler) comparison logic rather
 * than reusing findByLender/normalizeResults as-is. */
interface HlReal { name: string; amountLakh?: number; rate?: string }
function parseHlReal(json: unknown): HlReal[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && typeof (e as Record<string, unknown>).name === 'string')
    .map((e) => ({ name: e.name as string, amountLakh: typeof e.amountLakh === 'number' ? e.amountLakh : undefined, rate: typeof e.rate === 'string' ? e.rate : undefined }));
}
interface HlOwn { lender: string; eligible: boolean; reasons: string[]; estimatedRatePercent?: number; maxEligibleAmount?: number }
function parseHlOwn(json: unknown): HlOwn[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && typeof (e as Record<string, unknown>).lender === 'string' && typeof (e as Record<string, unknown>).eligible === 'boolean')
    .map((e) => ({
      lender: e.lender as string,
      eligible: e.eligible as boolean,
      reasons: Array.isArray(e.reasons) ? (e.reasons as string[]) : [],
      estimatedRatePercent: typeof e.estimatedRatePercent === 'number' ? e.estimatedRatePercent : undefined,
      maxEligibleAmount: typeof e.maxEligibleAmount === 'number' ? e.maxEligibleAmount : undefined,
    }));
}

function renderHlReport(rows: Array<{ id: string; conversationId: string; leadId: string | null; facts: unknown; realChainResults: unknown; ownBreResults: unknown; createdAt: Date }>): string {
  const parsed = rows.map((row) => ({
    ...row,
    facts: row.facts as Partial<HlEligibilityFacts>,
    real: parseHlReal(row.realChainResults),
    own: parseHlOwn(row.ownBreResults),
  }));

  const total = parsed.length;
  const perLenderAgreement = HL_LENDER_DISPLAY_NAMES.map((lender) => {
    let agree = 0;
    for (const row of parsed) {
      const realEligible = row.real.some((r) => lenderNamesMatch(r.name, lender));
      const own = row.own.find((o) => lenderNamesMatch(HL_LENDER_DISPLAY_NAME[o.lender as keyof typeof HL_LENDER_DISPLAY_NAME] ?? o.lender, lender));
      if (!own) continue; // our own engine should always return every lender — absence means this row predates a lender being added
      if (realEligible === own.eligible) agree++;
    }
    const comparable = parsed.filter((row) => row.own.some((o) => lenderNamesMatch(HL_LENDER_DISPLAY_NAME[o.lender as keyof typeof HL_LENDER_DISPLAY_NAME] ?? o.lender, lender))).length;
    return { lender, comparable, agree, pct: comparable ? Math.round((agree / comparable) * 100) : null };
  });

  let countMatchRows = 0;
  let countMatchTotal = 0;
  for (const row of parsed) {
    if (row.own.length) {
      countMatchTotal++;
      if (row.real.length === row.own.filter((r) => r.eligible).length) countMatchRows++;
    }
  }

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}% (${n}/${d})` : 'n/a (no comparable rows)');
  const pctNum = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
  const tier = (p: number | null) => (p === null ? 'tier-na' : p >= 80 ? 'tier-good' : p >= 50 ? 'tier-mid' : 'tier-bad');

  const summaryCards = perLenderAgreement
    .map((l) => {
      const p = pctNum(l.agree, l.comparable);
      return `<div class="sum-card ${tier(p)}">
          <div class="sum-card-name">${esc(l.lender)}</div>
          <div class="sum-card-pct">${p === null ? '—' : `${p}%`}</div>
          <div class="sum-card-sub">${p === null ? 'no comparable rows' : `agree ${l.agree}/${l.comparable}`}</div>
        </div>`;
    })
    .join('');

  const overallP = pctNum(countMatchRows, countMatchTotal);
  const summaryHtml = `
    <div class="panel">
      <h2 class="panel-title">Summary <span class="muted">— ${total} customer${total === 1 ? '' : 's'} compared</span></h2>
      <div class="sum-grid">${summaryCards}</div>
      <div class="sum-footnotes">
        <div class="footnote"><span class="pill ${tier(overallP)}">${pct(countMatchRows, countMatchTotal)}</span> exact eligible-lender-count match</div>
        <div class="footnote muted">Bitsflow side is eligible-lenders-only — absence from its list is read as "rejected", not "not attempted" (see HlBreComparison schema comment).</div>
      </div>
    </div>`;

  const hlCell = (real: HlReal | undefined, own: HlOwn | undefined) => {
    if (real) return `<div class="verdict verdict-yes">✓ ${esc(real.amountLakh ?? '?')}L <span class="rate">@ ${esc(real.rate ?? '?')}%</span></div>`;
    if (!own) return '<span class="dash">—</span>';
    if (own.eligible) return `<div class="verdict verdict-no">✗ rejected <span class="muted">(but ours says eligible)</span></div>`;
    const reason = own.reasons.length ? `<div class="reason" title="${esc(own.reasons.join('; '))}">${esc(own.reasons.join('; '))}</div>` : '';
    return `<div class="verdict verdict-no">✗ rejected</div>${reason}`;
  };
  const hlOwnCell = (own: HlOwn | undefined) => {
    if (!own) return '<span class="dash">—</span>';
    if (own.eligible) return `<div class="verdict verdict-yes">✓ ₹${esc(own.maxEligibleAmount ?? '?')} <span class="rate">@ ${esc(own.estimatedRatePercent ?? '?')}%</span></div>`;
    const reason = own.reasons.length ? `<div class="reason" title="${esc(own.reasons.join('; '))}">${esc(own.reasons.join('; '))}</div>` : '';
    return `<div class="verdict verdict-no">✗ not eligible</div>${reason}`;
  };

  const rowsHtml = parsed
    .map((row, i) => {
      const factsSummary = `₹${esc(row.facts?.monthlyIncome ?? '?')}/mo · CIBIL ${esc(row.facts?.cibilScore ?? '?')} · age ${esc(row.facts?.age ?? '?')} · property ₹${esc(row.facts?.propertyValue ?? '?')}`;
      const lenderCells = HL_LENDER_DISPLAY_NAMES.map((lender) => {
        const real = row.real.find((r) => lenderNamesMatch(r.name, lender));
        const own = row.own.find((o) => lenderNamesMatch(HL_LENDER_DISPLAY_NAME[o.lender as keyof typeof HL_LENDER_DISPLAY_NAME] ?? o.lender, lender));
        const realEligible = Boolean(real);
        const disagree = Boolean(own && realEligible !== own.eligible);
        return `<td class="lender-td${disagree ? ' disagree' : ''}">
            <div class="lender-name">${esc(lender)}</div>
            <div class="lender-split">
              <div class="lender-side"><div class="side-label">Bitsflow</div>${hlCell(real, own)}</div>
              <div class="lender-side"><div class="side-label">Ours</div>${hlOwnCell(own)}</div>
            </div>
          </td>`;
      }).join('');
      return `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td class="meta-td date-td">${row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
          <td class="meta-td conv-td">${esc(row.conversationId.slice(0, 8))}…</td>
          <td class="meta-td facts-td">${esc(factsSummary)}</td>
          ${lenderCells}
        </tr>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>HL BRE Comparison — internal</title>
  <meta name="robots" content="noindex" />
  <style>
    :root {
      --bg: #0a0a0c;
      --surface: #141417;
      --surface-2: #1b1b1f;
      --border: #2a2a30;
      --ink: #e8e8ec;
      --ink-soft: #9a9aa3;
      --ink-faint: #6b6b74;
      --accent: #60a5fa;
      --good: #34d399;
      --good-soft: rgba(52, 211, 153, 0.12);
      --mid: #fbbf24;
      --mid-soft: rgba(251, 191, 36, 0.12);
      --bad: #f87171;
      --bad-soft: rgba(248, 113, 113, 0.14);
      --na-soft: rgba(255, 255, 255, 0.04);
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 28px;
      margin: 0;
    }
    h1 { font-size: 19px; font-weight: 650; margin: 0 0 20px; letter-spacing: -0.01em; }
    .muted { color: var(--ink-faint); font-weight: 400; }

    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; margin-bottom: 22px; }
    .panel-title { margin: 0 0 16px; font-size: 14.5px; font-weight: 600; }

    .sum-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .sum-card { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; border-left: 3px solid transparent; }
    .sum-card-name { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
    .sum-card-pct { font-size: 20px; font-weight: 700; line-height: 1; margin-bottom: 4px; }
    .sum-card-sub { font-size: 11px; color: var(--ink-faint); }
    .tier-good { border-left-color: var(--good); } .tier-good .sum-card-pct { color: var(--good); }
    .tier-mid  { border-left-color: var(--mid); }  .tier-mid .sum-card-pct  { color: var(--mid); }
    .tier-bad  { border-left-color: var(--bad); }  .tier-bad .sum-card-pct  { color: var(--bad); }
    .tier-na   { border-left-color: var(--ink-faint); } .tier-na .sum-card-pct { color: var(--ink-faint); }

    .sum-footnotes { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .footnote { font-size: 12.5px; color: var(--ink-soft); display: flex; align-items: center; gap: 8px; }
    .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-weight: 650; font-size: 11.5px; }
    .pill.tier-good { background: var(--good-soft); color: var(--good); border-left: none; }
    .pill.tier-mid  { background: var(--mid-soft);  color: var(--mid);  border-left: none; }
    .pill.tier-bad  { background: var(--bad-soft);  color: var(--bad);  border-left: none; }
    .pill.tier-na   { background: var(--na-soft);   color: var(--ink-faint); border-left: none; }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 1400px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--surface-2); color: var(--ink-soft);
      padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .row-even td { background: var(--surface); }
    .row-odd td { background: #111114; }
    tbody tr:hover td { background: #1c1c20; }

    .meta-td { white-space: nowrap; }
    .date-td { color: var(--ink-soft); font-size: 11.5px; }
    .conv-td { color: var(--ink-faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .facts-td { font-size: 11.5px; white-space: normal; min-width: 160px; }

    .lender-td { min-width: 180px; border-left: 1px solid var(--border); }
    .lender-td.disagree { background: var(--bad-soft) !important; }
    .lender-name { font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
    .lender-split { display: flex; gap: 12px; }
    .lender-side { flex: 1; min-width: 0; }
    .side-label { font-size: 9.5px; color: var(--ink-faint); margin-bottom: 2px; }
    .verdict { font-weight: 650; font-size: 12.5px; }
    .verdict-yes { color: var(--good); }
    .verdict-no { color: var(--bad); }
    .rate { font-weight: 500; color: var(--ink-soft); }
    .reason { color: var(--ink-faint); font-size: 10.5px; margin-top: 3px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .dash { color: var(--ink-faint); }
  </style>
</head>
<body>
  <h1>Home Loan — BRE shadow-mode comparison</h1>
  ${summaryHtml}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Conversation</th>
          <th>Facts</th>
          ${HL_LENDER_DISPLAY_NAMES.map((l) => `<th>${esc(l)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</body>
</html>`;
}
