import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../lib/logger';

// The real Finfinity brand mark (same file the widget itself uses) — embedded via Content-ID
// rather than a data: URI, since cid: attachments render far more reliably across email clients
// (Outlook desktop in particular refuses inline data: URIs in HTML email). Read once at module
// load, not per-send. Designed for a dark background (its wordmark is pure white), hence the dark
// header band in buildHtml below rather than placing it directly on a white page.
const FINFINITY_LOGO_SVG = fs.readFileSync(path.join(__dirname, '../assets/finfinity-logo.svg'));

export interface RmSummaryInput {
  rm: { name: string; phone: string; email: string };
  customerName?: string;
  /** The real, full mobile number — deliberately NOT masked, unlike everywhere else in this
   * codebase (chat transcripts, the DB's mobileMasked column, etc.). This is an internal email to
   * the RM who needs to actually call the customer, not a customer-facing surface, so masking it
   * would defeat the entire point (2026-10-16 direct instruction). */
  mobile?: string;
  customerEmail?: string;
  product: string;
  loanType?: string;
  leadId?: string;
  // CIBIL score is deliberately never sent to the RM (2026-10-21 direct instruction) — removed
  // entirely rather than just left blank, so a future field added above doesn't accidentally end
  // up next to a half-finished "why is this missing" comment.
  /** Gold Loan/LAS only (2026-10-21 instruction: "send all the product info that is captured") —
   * every product-specific field the customer answered, label -> formatted value, in the order
   * they were asked. Every other product still only gets the generic rows above. */
  productDetails?: Array<{ label: string; value: string }>;
}

export interface EmailService {
  /** Fired once a lead exists (real or dummy) for any product — see routes/chat.ts, right where
   * the result step's response is built. Scope is deliberately just THIS conversation's product,
   * not a cross-conversation history of everything the customer has ever applied for — nothing in
   * the current schema links separate conversations for the same person together.
   *
   * Returns whether the send actually succeeded (security-review finding, 2026-10-23: this used to
   * be `Promise<void>`, and the caller marked the email "sent" — permanently, never retried —
   * BEFORE even calling this, so a real SMTP failure was indistinguishable from success and the RM
   * silently never found out about the lead). The caller now only persists "sent" when this
   * resolves true. */
  sendRmSummary(input: RmSummaryInput): Promise<boolean>;
}

function buildSubject(input: RmSummaryInput): string {
  // Security-review finding, 2026-10-23: customerName is interpolated straight into a raw email
  // header with no sanitization — a name containing a literal CR/LF could inject extra headers
  // (the classic email-header-injection pattern). Nodemailer does its own header encoding, but this
  // app shouldn't rely solely on that; stripping newlines here costs nothing and closes the gap
  // regardless of what the mail library does internally.
  const safeName = (input.customerName ?? 'Customer').replace(/[\r\n]/g, ' ');
  return `New lead — ${safeName} (${input.product})${input.leadId ? ` — ${input.leadId}` : ''}`;
}

// Finfinity's own brand palette, taken directly from the widget's CSS variables (widget/src/style.css)
// so this email actually looks like it came from the same product, not a generic notification.
const BRAND = {
  darkBg: '#0A0F0D',
  primary: '#25F0C0',
  primaryDim: '#1BC79F',
  primarySoft: 'rgba(37, 240, 192, 0.08)',
  ink: '#1A2421',
  inkSoft: '#5B7069',
  line: '#E7EEEC',
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Table-based layout throughout (not flex/grid) — the only markup email clients reliably render
 * consistently, Outlook desktop especially. Every color inlined, no external stylesheet. */
function buildHtml(input: RmSummaryInput): string {
  const rows: string[] = [];
  const row = (label: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return;
    const shaded = rows.length % 2 === 1;
    rows.push(`
      <tr style="background:${shaded ? BRAND.primarySoft : '#ffffff'};">
        <td style="padding:10px 16px;font-size:13px;color:${BRAND.inkSoft};border-bottom:1px solid ${BRAND.line};white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:10px 16px;font-size:13px;color:${BRAND.ink};font-weight:600;border-bottom:1px solid ${BRAND.line};text-align:right;">${escapeHtml(String(value))}</td>
      </tr>`);
  };
  row('Customer name', input.customerName);
  row('Mobile', input.mobile ? `+91 ${input.mobile}` : undefined);
  row('Email', input.customerEmail);
  row('Product', input.product);
  row('Loan type', input.loanType);
  row('Lead ID', input.leadId);
  for (const detail of input.productDetails ?? []) row(detail.label, detail.value);

  const firstName = input.customerName?.split(' ')[0];

  return `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#F3F6F5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BRAND.line};">
          <!-- Header: dark band, brand mark (designed for this background) -->
          <tr>
            <td style="background:${BRAND.darkBg};padding:22px 28px;">
              <img src="cid:finfinity-logo" alt="Finfinity" height="28" style="display:block;border:0;" />
            </td>
          </tr>
          <!-- Accent divider -->
          <tr><td style="height:4px;background:linear-gradient(90deg, ${BRAND.primary}, ${BRAND.primaryDim});line-height:4px;font-size:0;">&nbsp;</td></tr>
          <!-- Body -->
          <tr>
            <td style="padding:28px 28px 8px 28px;">
              <span style="display:inline-block;background:${BRAND.primarySoft};color:${BRAND.primaryDim};font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:5px 10px;border-radius:999px;">${escapeHtml(input.product)}</span>
              <h1 style="margin:14px 0 4px;font-size:20px;color:${BRAND.ink};">New lead${firstName ? `: ${escapeHtml(firstName)}` : ''}</h1>
              <p style="margin:0 0 20px;font-size:13.5px;color:${BRAND.inkSoft};">Assigned to you, <strong style="color:${BRAND.ink};">${escapeHtml(input.rm.name)}</strong> — please reach out shortly.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:10px;overflow:hidden;">
                ${rows.join('')}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 28px;background:#FAFCFB;border-top:1px solid ${BRAND.line};">
              <p style="margin:0;font-size:11px;color:${BRAND.inkSoft};">Automated notification from the <strong style="color:${BRAND.primaryDim};">Finfinity</strong> loan assistant.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

class MockEmailService implements EmailService {
  async sendRmSummary(input: RmSummaryInput): Promise<boolean> {
    logger.info({ event: 'rm_summary_email_mock', rmEmail: input.rm.email, product: input.product, leadId: input.leadId }, 'mock RM summary email (SMTP not configured — would have sent)');
    return true;
  }
}

/** Real — sends via a plain SMTP transport. No retry/queue: a failed send is logged, swallowed (never
 * surfaced to the customer — this is an internal notification, not something the customer's own flow
 * should ever break over), and reported back to the caller as `false` so it can avoid marking this
 * permanently "sent" (see EmailService's own doc comment). */
class RealEmailService implements EmailService {
  private transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });

  async sendRmSummary(input: RmSummaryInput): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: env.SMTP_FROM || env.SMTP_USER,
        to: input.rm.email,
        subject: buildSubject(input),
        html: buildHtml(input),
        attachments: [{ filename: 'finfinity-logo.svg', content: FINFINITY_LOGO_SVG, cid: 'finfinity-logo', contentType: 'image/svg+xml' }],
      });
      return true;
    } catch (err) {
      logger.error({ err, event: 'rm_summary_email_failed', rmEmail: input.rm.email, product: input.product }, 'failed to send RM summary email');
      return false;
    }
  }
}

export const emailService: EmailService = env.SMTP_HOST ? new RealEmailService() : new MockEmailService();
