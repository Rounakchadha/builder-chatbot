import { describeApiError, type ChatApi } from './api';
import { ICON } from './icons';

// Field labels/values here are customer-typed (email, GST number, business address, etc.) and get
// dropped straight into innerHTML below — escape them first or a value like `<img onerror=...>`
// runs as real HTML in the page (security-review finding, 2026-11-02).
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The live "your details" sidebar — mirrors whatever the bot has captured so far and lets the
 * customer correct it directly (click the pencil, type, save) instead of having to say it in
 * chat. Edits go through the same server-side validation as a normal answer, and if eligibility
 * was already computed it's recalculated immediately — the caller is notified via onResultUpdated
 * so it can post the "what changed" chat bubbles and refresh the result card in place.
 *
 * onEditStarted (2026-11-10 fix): fired right before the save request goes out — CIS reported the
 * old (pre-edit) eligibility cards sitting on screen, unchanged, for the whole recalculation
 * round-trip, with no indication anything was happening until the new numbers suddenly appeared.
 * Lets the caller swap those stale cards for a loading state immediately, instead of only reacting
 * once the new result is already in hand.
 */
export class ProfilePanel {
  constructor(
    private root: HTMLElement,
    private api: ChatApi,
    private getSessionToken: () => string | null,
    private onResultUpdated: (result: unknown, messages: string[]) => void,
    private onEditStarted: () => void,
  ) {}

  async refresh(): Promise<void> {
    const token = this.getSessionToken();
    if (!token) return;
    const { fields } = await this.api.profile(token);
    this.render(fields);
  }

  // Markup/classes below (.la-detail/.la-detail-line/.la-detail-edit/.la-empty) are copied verbatim
  // from CIS's design deliverables' "Your details" sidebar — see style.css's CIS component CSS
  // block, appended 2026-10-28. Only the business logic (edit/save wiring) below is ours.
  private render(fields: { key: string; label: string; value: string; editable: boolean }[]) {
    this.root.innerHTML = '';
    if (fields.length === 0) {
      this.root.innerHTML = '<div class="la-empty">What you share will show up here as we go — and you can edit it anytime.</div>';
      return;
    }
    for (const f of fields) {
      const row = document.createElement('div');
      row.className = 'la-detail';
      row.innerHTML = `
        <label>${escapeHtml(f.label)}</label>
        <div class="la-detail-line">
          <strong>${escapeHtml(f.value)}</strong>
          ${f.editable ? `<button class="la-detail-edit" aria-label="Edit ${escapeHtml(f.label)}" type="button">Edit</button>` : ''}
        </div>
      `;
      if (f.editable) {
        row.querySelector<HTMLButtonElement>('.la-detail-edit')!.onclick = () => this.startEdit(row, f);
      }
      this.root.appendChild(row);
    }
  }

  private startEdit(row: HTMLElement, field: { key: string; label: string; value: string }) {
    const valueRow = row.querySelector<HTMLElement>('.la-detail-line')!;
    const rawValue = field.value.replace(/[₹,]/g, '').replace(/\/mo$/, '');
    valueRow.innerHTML = `
      <input class="la-input" value="${escapeHtml(rawValue)}" />
      <button class="la-detail-edit" aria-label="Save" type="button">${ICON.check}</button>
    `;
    const input = valueRow.querySelector<HTMLInputElement>('input')!;
    input.focus();
    input.select();

    const save = async () => {
      // Bug fixed 2026-11-02: saving with no actual change (e.g. opening Edit, then just tapping
      // the checkmark without typing anything) used to still call the server and post a "Got it —
      // X updated to Y" chat bubble even though Y was already Y — confusing since nothing changed.
      if (input.value.trim() === rawValue.trim()) {
        await this.refresh();
        return;
      }
      const token = this.getSessionToken();
      if (!token) return;
      const saveBtn = valueRow.querySelector<HTMLButtonElement>('.la-detail-edit')!;
      saveBtn.disabled = true;
      const showError = (message: string) => {
        let err = row.querySelector<HTMLElement>('.la-error');
        if (!err) {
          err = document.createElement('div');
          err.className = 'la-error';
          row.appendChild(err);
        }
        err.textContent = message;
        saveBtn.disabled = false;
      };
      this.onEditStarted();
      let result: Awaited<ReturnType<ChatApi['editField']>>;
      try {
        result = await this.api.editField(token, field.key, input.value);
      } catch (e) {
        showError(describeApiError(e, "Couldn't save that."));
        return;
      }
      if (result.ok) {
        const messages = [result.summaryMessage, result.eligibilityMessage].filter((m): m is string => Boolean(m));
        this.onResultUpdated(result.resultPayload, messages);
        await this.refresh();
      } else {
        showError(result.error ?? "Couldn't save that.");
      }
    };
    // Bug fixed 2026-10-31 ("tick button vanishes and nothing happens"): this looked for
    // '.lc-sidebar-save', a class that was never actually rendered anywhere — the button above is
    // '.la-detail-edit' (reused for both the original Edit button and this save button). The
    // querySelector call always returned null, so `.onclick = save` threw immediately and no
    // handler was ever attached — the save button was visible but completely inert.
    valueRow.querySelector<HTMLButtonElement>('.la-detail-edit')!.onclick = save;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  }
}
