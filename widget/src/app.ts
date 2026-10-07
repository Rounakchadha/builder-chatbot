import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse, type InputSpec } from '@loan-chatbot/shared';
import { ChatApi, SessionExpiredError } from './api';
import finfinityLogo from './assets/finfinity-logo.svg?raw';
import { ICON } from './icons';
import { ProfilePanel } from './profilePanel';
import { renderResultCard } from './resultCard';
// `?inline` gets the fully-processed CSS (Tailwind included) as a plain string instead of Vite
// auto-injecting it into the host page's <head> — we inject it ourselves into a shadow root
// instead, so none of it (including Tailwind's global Preflight reset) ever touches the host
// page's own elements, and none of the host page's own global CSS leaks in either.
import widgetStyles from './style.css?inline';

const STORAGE_KEY = 'lc_session_token_v1';
// Public, documented key name (see test-page's admin control) — a separate token from
// STORAGE_KEY, pointing at a short-lived, server-side "already verified this mobile+OTP" record
// (see server/src/services/identity.service.ts). Present only once mobile+OTP has actually been
// verified; sent back on the next brand-new session so it can skip asking for both again, as
// long as it's still within the remembered window.
const IDENTITY_STORAGE_KEY = 'lc_identity_token_v1';
const LOADING_LABEL: Record<string, string> = {
  dedupeCheck: 'Checking your details…',
  panFetch: 'Looking up your details…',
  bureauFetchFound: 'Fetching your credit report…',
  bureauFetchNotFound: 'Fetching your credit report…',
  result: 'Checking your eligibility across lenders…',
};
// The server runs the NEXT auto-step's real work (a bank API call that can take a few seconds)
// inside the same request that answers the step named here — the client has no visibility into
// that wait until the response finally comes back. Keyed by the step being submitted/continued,
// so the right spinner label shows up immediately, before the wait, not after it.
const NEXT_STEP_LOADING_LABEL: Record<string, string> = {
  mobile: 'Sending you a one-time code…',
  pan: 'Looking up your details…',
  otpDedupe: 'Checking your details…',
  otpBureauFound: 'Fetching your credit report…',
  otpBureauNotFound: 'Fetching your credit report…',
  panDuplicateChoice: 'One moment…',
  emailDuplicateChoice: 'One moment…',
  // 'profileSummary' isn't here — it gets the dedicated skeleton card (showSkeletonCard) instead
  // of this generic spinner row, since it's the eligibility computation itself.
};

export interface ChatWidgetOptions {
  apiBaseUrl: string;
  mountTo?: HTMLElement; // defaults to document.body
}

export class ChatWidget {
  private api: ChatApi;
  private sessionToken: string | null = null;
  private started = false;
  private resultCardShown = false;
  /** Set by submitUserValue when a submission (currently: OTP) shouldn't add its chat bubble until
   * we actually know it was accepted — an OTP retry loop would otherwise leave a stack of
   * identical, uninformative "••••••" bubbles in the log for every wrong attempt. Consumed (shown,
   * or discarded on error) the next time renderTurn runs. */
  private pendingUserBubbleText: string | null = null;
  private resultCollapsed = false;
  private panOfferOffered = false;
  private panOfferNeedsMobile = false;
  private panOfferResolved: 'declined' | 'shared' | null = null;
  private statusActionsShown = false;
  private profilePanel!: ProfilePanel;

  private panelEl!: HTMLDivElement;
  private launcherEl!: HTMLButtonElement;
  private bodyEl!: HTMLDivElement;
  private chatLogEl!: HTMLDivElement;
  private composerEl!: HTMLDivElement;
  private resultContainerEl!: HTMLDivElement;
  private progressFillEl!: HTMLDivElement;
  private progressStepEl!: HTMLSpanElement;
  private progressPctEl!: HTMLSpanElement;

  constructor(private opts: ChatWidgetOptions) {
    this.api = new ChatApi(opts.apiBaseUrl);
    this.sessionToken = localStorage.getItem(STORAGE_KEY);
    this.buildDom();
  }

  private buildDom() {
    // A shadow root gives full style encapsulation in both directions — the host page's global
    // CSS (resets, frameworks, its own Tailwind build) can't reach in, and nothing in here
    // (Tailwind's Preflight included) can leak out onto the host page. See widgetStyles above.
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = widgetStyles;
    shadow.appendChild(styleEl);

    const root = document.createElement('div');
    root.className = 'lc-root';

    const launcher = document.createElement('button');
    launcher.className = 'lc-launcher';
    launcher.setAttribute('aria-label', 'Open loan eligibility chat');
    launcher.innerHTML = ICON.chat;
    launcher.onclick = () => this.toggle();

    const panel = document.createElement('div');
    panel.className = 'lc-panel';
    panel.innerHTML = `
      <div class="lc-masthead">
        <div class="lc-masthead-top">
          <div class="lc-masthead-left">
            <div class="lc-logo">${finfinityLogo}</div>
            <div class="lc-masthead-divider"></div>
            <div>
              <h1>Loan eligibility assistant</h1>
              <p>Typically replies instantly</p>
            </div>
          </div>
          <div class="lc-masthead-right">
            <div class="lc-progress-wrap">
              <div class="lc-progress-label">
                <span class="lc-progress-step">Getting started</span>
                <span class="lc-progress-pct"></span>
              </div>
              <div class="lc-progress-track"><div class="lc-progress-fill"></div></div>
            </div>
            <button class="lc-start-over" type="button">${ICON.restart} Start over</button>
            <button class="lc-close" aria-label="Close chat">${ICON.close}</button>
          </div>
        </div>
      </div>
      <div class="lc-content-row">
        <div class="lc-body">
          <div class="lc-chat-log"></div>
          <div class="lc-composer"></div>
        </div>
        <aside class="lc-sidebar">
          <div class="lc-sidebar-header">
            <div class="lc-sidebar-title">Your details</div>
            <div class="lc-sidebar-subtitle">Saved automatically as you go</div>
          </div>
          <div class="lc-sidebar-fields"></div>
        </aside>
      </div>
    `;
    panel.querySelector<HTMLButtonElement>('.lc-close')!.onclick = () => this.toggle(false);
    panel.querySelector<HTMLButtonElement>('.lc-start-over')!.onclick = () => {
      if (confirm('Start a new eligibility check? This will discard your current progress.')) this.restart();
    };

    this.panelEl = panel;
    this.launcherEl = launcher;
    this.profilePanel = new ProfilePanel(
      panel.querySelector('.lc-sidebar-fields')!,
      this.api,
      () => this.sessionToken,
      (result, messages) => void this.applyUpdatedResult(result, messages),
    );
    this.bodyEl = panel.querySelector('.lc-body')!;
    this.chatLogEl = panel.querySelector('.lc-chat-log')!;
    this.composerEl = panel.querySelector('.lc-composer')!;
    this.progressFillEl = panel.querySelector('.lc-progress-fill')!;
    this.progressStepEl = panel.querySelector('.lc-progress-step')!;
    this.progressPctEl = panel.querySelector('.lc-progress-pct')!;

    root.appendChild(panel);
    root.appendChild(launcher);
    shadow.appendChild(root);
    (this.opts.mountTo ?? document.body).appendChild(host);
  }

  private toggle(force?: boolean) {
    const open = force ?? !this.panelEl.classList.contains('lc-open');
    this.panelEl.classList.toggle('lc-open', open);
    this.launcherEl.classList.toggle('lc-launcher-open', open);
    if (open && !this.started) {
      this.started = true;
      void this.start();
    }
  }

  private async start(): Promise<void> {
    try {
      const resp = this.sessionToken
        ? await this.api.send({ sessionToken: this.sessionToken })
        : await this.api.send({ identityToken: localStorage.getItem(IDENTITY_STORAGE_KEY) ?? undefined });
      this.sessionToken = resp.sessionToken;
      localStorage.setItem(STORAGE_KEY, resp.sessionToken);
      await this.renderTurn(resp);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        localStorage.removeItem(STORAGE_KEY);
        this.sessionToken = null;
        return this.start();
      }
      this.renderFatalError();
    }
  }

  private scrollDown() {
    requestAnimationFrame(() => {
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    });
  }

  private scrollToResultTop() {
    requestAnimationFrame(() => {
      this.resultContainerEl.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  }

  private appendUserBubble(text: string) {
    const row = document.createElement('div');
    row.className = 'lc-row lc-user';
    row.innerHTML = `<div class="lc-bubble"></div>`;
    row.querySelector('.lc-bubble')!.textContent = text;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
  }

  private async appendBotBubble(html: string, hint?: string | null) {
    const typingRow = document.createElement('div');
    typingRow.className = 'lc-row lc-bot';
    typingRow.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-typing"><span></span><span></span><span></span></div>`;
    this.chatLogEl.appendChild(typingRow);
    this.scrollDown();
    await sleep(500);
    typingRow.remove();

    const row = document.createElement('div');
    row.className = 'lc-row lc-bot';
    row.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-bubble-wrap"><div class="lc-bubble">${html}</div>${
      hint ? `<div class="lc-hint">${hint}</div>` : ''
    }</div>`;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
  }

  private async appendLoadingThenBot(label: string, html: string, hint?: string | null) {
    const row = document.createElement('div');
    row.className = 'lc-row lc-bot';
    row.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-loading-row"><div class="lc-spinner"></div><span></span></div>`;
    row.querySelector('span')!.textContent = label;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
    await sleep(900);
    row.remove();
    await this.appendBotBubble(html, hint);
  }

  private updateProgress(resp: ChatTurnResponse) {
    const pct = Math.round((resp.progress.stepNumber / Math.max(resp.progress.totalSteps, 1)) * 100);
    this.progressFillEl.style.width = `${pct}%`;
    this.progressStepEl.textContent = `Step ${resp.progress.stepNumber} of ${resp.progress.totalSteps}`;
    this.progressPctEl.textContent = resp.progress.label;
  }

  private clearComposer() {
    this.composerEl.innerHTML = '';
  }

  private async renderTurn(resp: ChatTurnResponse) {
    this.updateProgress(resp);

    // Present once mobile+OTP is freshly verified — stored so a future brand-new session (a
    // normal restart, or just reopening the widget) can skip asking for both again, as long as
    // it's still within the remembered window. Safe to re-store the same value repeatedly.
    if (resp.identityToken) localStorage.setItem(IDENTITY_STORAGE_KEY, resp.identityToken);

    if (resp.errorText) {
      // The submission was rejected — discard any deferred bubble for it (a wrong OTP never gets
      // one), rather than showing it now next to the error.
      this.pendingUserBubbleText = null;
      // Re-render the same question's input with an inline error — no new bot bubble, to avoid
      // repeating the same question verbatim on every mistaken attempt.
      this.renderComposer(resp);
      const err = document.createElement('div');
      err.className = 'lc-error-text';
      err.textContent = resp.errorText;
      this.composerEl.prepend(err);

      // A "none"-type step (an automatic background check, not a question) normally has no
      // composer at all — if THAT failed (e.g. a bank API timing out), the customer needs an
      // explicit way to try again rather than being stuck looking at an empty box. errorAction
      // 'restart' means retrying this exact step can only ever fail the same way again (a genuine
      // dead end) — a button that leads somewhere beats one that just repeats the same failure.
      if (resp.input.type === 'none') {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'lc-ghost-btn';
        if (resp.errorAction === 'restart') {
          actionBtn.textContent = 'Restart chat';
          actionBtn.onclick = () => this.restart();
        } else {
          actionBtn.textContent = 'Try again';
          actionBtn.onclick = () => void this.sendAndRender(resp.stepId, undefined);
        }
        this.composerEl.appendChild(actionBtn);
      }

      this.scrollDown();
      return;
    }

    // Accepted — show the deferred bubble now (right before whatever the bot says next), since we
    // now know it was the answer that actually worked.
    if (this.pendingUserBubbleText) {
      this.appendUserBubble(this.pendingUserBubbleText);
      this.pendingUserBubbleText = null;
    }

    if (resp.botMessage) {
      // 'result' is always flagged loading server-side, but by the time it gets here the real
      // wait already happened (the skeleton card covered it) — layering on this decorative
      // 900ms-minimum spinner too would just add a second, pointless loading moment right after
      // the first one, which is exactly the "loader still showed after the skeleton" complaint.
      if (resp.loading && resp.stepId !== 'result') {
        await this.appendLoadingThenBot(LOADING_LABEL[resp.stepId] ?? 'One moment…', resp.botMessage, resp.hint);
      } else {
        await this.appendBotBubble(resp.botMessage, resp.hint);
      }
    }

    if (resp.done) {
      // The result card is built once; a later message sent from the persistent chat bar below it
      // (a follow-up question, small talk, etc.) comes back with done:true too, but we just show
      // the reply above and leave the card + chat bar exactly as they are — never rebuild them.
      const isFirstResultRender = resp.stepId === 'result' && Boolean(resp.result) && !this.resultCardShown;
      if (isFirstResultRender) {
        this.clearComposer();
        this.resultContainerEl = document.createElement('div');
        this.composerEl.appendChild(this.resultContainerEl);
        this.panOfferOffered = resp.panOffer ?? false;
        this.panOfferNeedsMobile = resp.panOfferNeedsMobile ?? false;
        this.renderResultInto(resp.result);
        this.resultCardShown = true;
      } else if (resp.stepId === 'result' && resp.statusCheck && !this.statusActionsShown) {
        this.renderStatusActions();
        this.statusActionsShown = true;
      }
      void this.profilePanel.refresh();
      // The card's own header (the headline eligibility figure) is what matters on first render —
      // scrollDown() would instead land on its last section (the RM contact block), since the
      // card itself is often taller than the visible chat body.
      if (isFirstResultRender) {
        this.scrollToResultTop();
      } else {
        this.scrollDown();
      }
      return;
    }

    this.renderComposer(resp);
    this.scrollDown();

    if (resp.input.type === 'none') {
      // Auto-continue past a step that has no user input (apiFetch/message) — see server
      // architecture notes. Skip refreshing the profile panel here: this step has nothing for the
      // customer to look at yet, and the not-found branch alone can chain several of these in a
      // row (panFetch/panDuplicateCheck/emailDuplicateCheck/bureauFetch/...) — refreshing once
      // below, when we actually land on something interactive, covers everything they collected
      // along the way in a single request instead of one per hop.
      await sleep(300);
      void this.sendAndRender(resp.stepId, undefined);
    } else {
      void this.profilePanel.refresh();
    }
  }

  /** (Re)renders the result card into its own container — kept separate from the sticky chat bar
   * appended after it, so a profile-panel edit can refresh just the numbers without disturbing it. */
  private renderResultInto(result: unknown) {
    this.resultContainerEl.innerHTML = renderResultCard(result as any);
    const restartBtn = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-btn-restart');
    if (restartBtn) restartBtn.onclick = () => this.restart();
    this.wireResultMinimize();
    this.wireLenderToggles();
    this.renderPanOffer();
  }

  /** Each lender row is a click-to-expand accordion showing the same numbers in fuller detail
   * (total payable, total interest) — built once per render since renderResultCard regenerates
   * fresh row/detail pairs every time. */
  private wireLenderToggles() {
    this.resultContainerEl.querySelectorAll<HTMLButtonElement>('[data-lender-toggle]').forEach((row) => {
      const idx = row.dataset.lenderToggle;
      const detail = this.resultContainerEl.querySelector<HTMLElement>(`#lc-lender-detail-${idx}`);
      if (!detail) return;
      row.onclick = () => {
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : 'block';
        row.classList.toggle('lc-lender-row-open', !isOpen);
      };
    });
  }

  /** Called when a profile-panel edit changes something — posts a bot bubble confirming what
   * changed (and, if eligibility got recomputed, a second one saying so) before refreshing the
   * result card's numbers in place, preserving whether it was minimized. */
  private async applyUpdatedResult(result?: unknown, messages: string[] = []) {
    for (const message of messages) {
      await this.appendBotBubble(message);
    }
    this.scrollDown();
    if (result === undefined || !this.resultCardShown) return;
    this.renderResultInto(result);
  }

  /** Rebuilding the result card (renderResultInto) wipes the empty #lc-pan-offer container it
   * leaves behind — this repopulates it from whatever state we're in (not offered / pending /
   * already answered), so the offer survives a profile-panel edit's card refresh. */
  private renderPanOffer() {
    const container = this.resultContainerEl.querySelector<HTMLElement>('#lc-pan-offer');
    if (!container) return;

    if (this.panOfferResolved) {
      container.innerHTML = `<div class="lc-hint" style="margin-top:10px">${
        this.panOfferResolved === 'shared' ? "Thanks — an RM will reach out shortly." : 'You can always start a new check to share it later.'
      }</div>`;
      return;
    }
    if (!this.panOfferOffered) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="lc-field-label" style="margin-top:14px">Want an RM to follow up directly?</div>
      <div class="lc-choice-row">
        <button class="lc-choice-btn" id="lc-pan-offer-yes">${this.panOfferNeedsMobile ? 'Yes, share details' : 'Yes, share PAN'}</button>
        <button class="lc-choice-btn" id="lc-pan-offer-no">No thanks</button>
      </div>
    `;
    container.querySelector<HTMLButtonElement>('#lc-pan-offer-yes')!.onclick = () => this.showPanOfferInput();
    container.querySelector<HTMLButtonElement>('#lc-pan-offer-no')!.onclick = () => void this.resolvePanOffer({ decision: 'decline' });
  }

  private showPanOfferInput() {
    const container = this.resultContainerEl.querySelector<HTMLElement>('#lc-pan-offer')!;
    container.innerHTML = `
      ${
        this.panOfferNeedsMobile
          ? `<div class="lc-field-label" style="margin-top:14px">Your mobile number</div>
             <input class="lc-input" id="lc-pan-offer-mobile" type="tel" placeholder="10-digit mobile number" maxlength="10" style="margin-bottom:8px">`
          : ''
      }
      <div class="lc-field-label" style="margin-top:14px">Your PAN</div>
      <div class="lc-chatbar">
        <input class="lc-chatbar-input" type="text" placeholder="ABCDE1234F" maxlength="10">
        <button class="lc-chatbar-send" aria-label="Send">${ICON.send}</button>
      </div>
      <div class="lc-error-text" id="lc-pan-offer-error" style="display:none"></div>
    `;
    const mobileInput = container.querySelector<HTMLInputElement>('#lc-pan-offer-mobile');
    const input = container.querySelector<HTMLInputElement>('.lc-chatbar-input')!;
    const btn = container.querySelector<HTMLButtonElement>('.lc-chatbar-send')!;
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase();
    });
    const submit = () => void this.resolvePanOffer({ pan: input.value.trim(), mobile: mobileInput?.value.trim() });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    btn.onclick = submit;
    (mobileInput ?? input).focus();
  }

  private async resolvePanOffer(opts: { decision: 'decline' } | { pan: string; mobile?: string }) {
    const outcome = await this.api.panOffer(this.sessionToken!, opts);
    if (!outcome.ok) {
      const errEl = this.resultContainerEl.querySelector<HTMLElement>('#lc-pan-offer-error');
      if (errEl) {
        errEl.textContent = outcome.error ?? 'Something went wrong — please try again.';
        errEl.style.display = 'block';
      }
      return;
    }
    this.panOfferResolved = 'pan' in opts ? 'shared' : 'declined';
    if (outcome.resultPayload) void this.applyUpdatedResult(outcome.resultPayload);
    else this.renderPanOffer();
  }

  private renderComposer(resp: ChatTurnResponse) {
    this.clearComposer();
    const input = resp.input;
    switch (input.type) {
      case 'mobile':
        this.renderChatBar(resp.stepId, { type: 'tel', maxLength: 10, placeholder: 'Type your 10-digit mobile number…', inputMode: 'numeric' });
        break;
      case 'pan':
        this.renderChatBar(resp.stepId, { type: 'text', maxLength: 10, placeholder: 'Type your PAN, e.g. ABCDE1234F…', uppercase: true });
        break;
      case 'number':
        // Deliberately type="text", not "number" — a native number input blocks typing words
        // like "no"/"none"/"85k", and the server (parseAmount) understands those anyway.
        this.renderChatBar(resp.stepId, { type: 'text', inputMode: 'decimal', placeholder: input.placeholder ? `Type ${input.placeholder}…` : 'Type your answer…' });
        break;
      case 'text':
        this.renderChatBar(resp.stepId, {
          type: 'text',
          placeholder: input.placeholder ? `Type ${input.placeholder}…` : 'Type your answer…',
          maxLength: input.maxLength,
          inputMode: input.maxLength ? 'numeric' : undefined,
        });
        break;
      case 'otp':
        this.renderOtpComposer(resp.stepId, input.length);
        break;
      case 'choice':
        this.renderChoiceComposer(resp.stepId, input.options, input.layout);
        break;
      case 'typeahead':
        this.renderTypeaheadComposer(resp.stepId, input.searchKey, input.placeholder);
        break;
      case 'date':
        this.renderChatBar(resp.stepId, { type: 'date', max: input.max });
        break;
      case 'none':
        break;
    }
  }

  /** A single persistent chat-input bar (pill text field + inline round send button) — used for
   * every free-text step (mobile, PAN, number, text) so typing feels like a normal chat rather
   * than filling out a labeled form field. */
  private renderChatBar(
    stepId: string,
    opts: { type: string; placeholder?: string; maxLength?: number; inputMode?: string; uppercase?: boolean; max?: string },
  ) {
    const wrap = document.createElement('div');
    wrap.className = 'lc-chatbar';

    const input = document.createElement('input');
    input.className = 'lc-chatbar-input';
    input.type = opts.type;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    if (opts.inputMode) input.inputMode = opts.inputMode as any;
    if (opts.uppercase) input.style.textTransform = 'uppercase';
    if (opts.max) input.max = opts.max;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    if (opts.uppercase) {
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase();
      });
    }

    const btn = document.createElement('button');
    btn.className = 'lc-chatbar-send';
    btn.setAttribute('aria-label', 'Send');
    btn.innerHTML = ICON.send;
    const submit = () => {
      if (!input.value.trim()) return;
      this.submitUserValue(stepId, input.value, input.value);
    };
    btn.onclick = submit;

    wrap.appendChild(input);
    wrap.appendChild(btn);
    this.composerEl.appendChild(wrap);
    input.focus();
  }

  /** Basic flow: every choice question is a fixed set of buttons, no typing or fuzzy matching —
   * clicking sends the option's exact text straight through. */
  private renderChoiceComposer(stepId: string, options: string[], layout: 'row' | 'column') {
    const wrap = document.createElement('div');
    wrap.className = `lc-choice-row lc-choice-${layout}`;
    for (const option of options) {
      const btn = document.createElement('button');
      btn.className = 'lc-choice-btn';
      btn.textContent = option;
      btn.onclick = () => this.submitUserValue(stepId, option, option);
      wrap.appendChild(btn);
    }
    this.composerEl.appendChild(wrap);
  }

  /** Type-to-search against a large server-side list (e.g. the employer master) — debounced search
   * as the customer types, a dropdown of matches to pick from, and an always-present "Others"
   * option for anything not found. Selecting either submits immediately, same as a choice button. */
  private renderTypeaheadComposer(stepId: string, searchKey: string, placeholder?: string) {
    const wrap = document.createElement('div');
    wrap.className = 'lc-typeahead-wrap';

    const input = document.createElement('input');
    input.className = 'lc-chatbar-input';
    input.type = 'text';
    input.placeholder = placeholder ? `${placeholder}…` : 'Type to search…';

    const list = document.createElement('div');
    list.className = 'lc-typeahead-list';
    list.style.display = 'none';

    const renderList = (matches: string[]) => {
      list.innerHTML = '';
      for (const match of matches) {
        const item = document.createElement('button');
        item.className = 'lc-typeahead-item';
        item.textContent = match;
        item.onclick = () => this.submitUserValue(stepId, match, match);
        list.appendChild(item);
      }
      const other = document.createElement('button');
      other.className = 'lc-typeahead-item lc-typeahead-other';
      other.textContent = "Others (not listed)";
      other.onclick = () => this.submitUserValue(stepId, 'Others', 'Others');
      list.appendChild(other);
      list.style.display = 'block';
      // The list growing taller doesn't move the panel's own scroll position — without this, the
      // newly shown matches can render below the fold, looking like nothing appeared at all.
      this.scrollDown();
    };

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (query.length < 2) {
        list.style.display = 'none';
        return;
      }
      debounceTimer = setTimeout(async () => {
        try {
          const { matches } = await this.api.typeaheadSearch(searchKey, query);
          renderList(matches);
        } catch {
          renderList([]); // still show the "Others" fallback even if the search itself failed
        }
      }, 250);
    });

    wrap.appendChild(input);
    wrap.appendChild(list);
    this.composerEl.appendChild(wrap);
    input.focus();
  }

  /** The status-check branch otherwise dead-ends after reporting the lead's status — this gives a
   * way straight back into either flow without going via "Start over" (which re-asks the intent
   * question as a normal chat turn instead of just jumping in). */
  private renderStatusActions() {
    this.clearComposer();
    const wrap = document.createElement('div');
    wrap.className = 'lc-choice-row lc-choice-column';

    const eligibilityBtn = document.createElement('button');
    eligibilityBtn.className = 'lc-choice-btn';
    eligibilityBtn.textContent = 'Check my eligibility';
    eligibilityBtn.onclick = () => void this.restartWithIntent(CHECK_ELIGIBILITY);

    const statusBtn = document.createElement('button');
    statusBtn.className = 'lc-choice-btn';
    statusBtn.textContent = 'Check status again';
    statusBtn.onclick = () => void this.restartWithIntent(CHECK_EXISTING_APPLICATION);

    wrap.appendChild(eligibilityBtn);
    wrap.appendChild(statusBtn);
    this.composerEl.appendChild(wrap);
  }

  /** Starts a brand-new session and immediately answers the 'intent' step with the given choice,
   * skipping straight to the next question instead of re-showing the intent prompt. */
  private async restartWithIntent(intent: string) {
    localStorage.removeItem(STORAGE_KEY);
    this.sessionToken = null;
    this.resultCardShown = false;
    this.resultCollapsed = false;
    this.panOfferOffered = false;
    this.panOfferNeedsMobile = false;
    this.panOfferResolved = null;
    this.statusActionsShown = false;
    this.chatLogEl.innerHTML = '';
    this.clearComposer();
    try {
      const start = await this.api.send({});
      this.sessionToken = start.sessionToken;
      localStorage.setItem(STORAGE_KEY, start.sessionToken);
      const answered = await this.api.send({ sessionToken: this.sessionToken, stepId: 'intent', value: intent });
      await this.renderTurn(answered);
    } catch (err) {
      this.renderFatalError();
    }
  }

  private renderOtpComposer(stepId: string, length: number) {
    const wrap = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'lc-field-label';
    l.textContent = 'One-time password';
    wrap.appendChild(l);

    const boxes = document.createElement('div');
    boxes.className = 'lc-otp-boxes';
    const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < length; i++) {
      const inp = document.createElement('input');
      inp.className = 'lc-input';
      inp.maxLength = 1;
      inp.inputMode = 'numeric';
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '');
        if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus();
      });
      inputs.push(inp);
      boxes.appendChild(inp);
    }
    wrap.appendChild(boxes);

    const btn = document.createElement('button');
    btn.className = 'lc-primary-btn';
    btn.textContent = 'Verify OTP';
    btn.onclick = () => {
      const code = inputs.map((i) => i.value).join('');
      // Deferred: a wrong attempt shouldn't leave a "••••••" bubble sitting in the chat log
      // forever — only worth showing once we know it actually worked.
      this.submitUserValue(stepId, code, '••••••', true);
    };
    wrap.appendChild(btn);

    const resend = document.createElement('button');
    resend.className = 'lc-ghost-btn';
    resend.textContent = 'Resend OTP';
    resend.onclick = async () => {
      resend.disabled = true;
      resend.textContent = 'Sending…';
      const result = await this.api.resendOtp(this.sessionToken!);
      if ('ok' in result) {
        await this.appendBotBubble("I've sent you a new OTP.");
      } else {
        await this.appendBotBubble(result.message ?? "Couldn't resend the OTP right now — please try again shortly.");
      }
      resend.disabled = false;
      resend.textContent = 'Resend OTP';
    };
    wrap.appendChild(resend);

    this.composerEl.appendChild(wrap);
    inputs[0].focus();
  }

  private submitUserValue(stepId: string, value: string, displayText: string, deferBubbleUntilAccepted = false) {
    if (deferBubbleUntilAccepted) {
      this.pendingUserBubbleText = displayText;
    } else {
      this.appendUserBubble(displayText);
    }
    this.clearComposer();
    void this.sendAndRender(stepId, value);
  }

  /** Shown immediately (before the request even goes out), not after — see NEXT_STEP_LOADING_LABEL. */
  private showLoadingRow(label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'lc-row lc-bot';
    row.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-loading-row"><div class="lc-spinner"></div><span></span></div>`;
    row.querySelector('span')!.textContent = label;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
    return row;
  }

  /** Shown the instant the eligibility computation starts (this is the slowest step — a real
   * lead-creation + lender-offers round trip) — a placeholder shaped like the real result card,
   * not a number, since we don't have one yet and showing a made-up one would be misleading. */
  private showSkeletonCard(): HTMLElement {
    this.clearComposer();
    const card = document.createElement('div');
    card.className = 'lc-skeleton-card';
    card.innerHTML = `
      <div class="lc-skeleton-badge"></div>
      <div class="lc-skeleton-estimating">Estimating<span class="lc-skeleton-dots"><span></span><span></span><span></span></span></div>
      <div class="lc-skeleton-bar lc-skeleton-bar-amount"></div>
      <div class="lc-skeleton-grid">
        <div class="lc-skeleton-bar"></div>
        <div class="lc-skeleton-bar"></div>
        <div class="lc-skeleton-bar"></div>
        <div class="lc-skeleton-bar"></div>
      </div>
    `;
    this.composerEl.appendChild(card);
    this.scrollDown();
    return card;
  }

  private async sendAndRender(stepId: string | undefined, value: string | undefined) {
    const isEligibilityCompute = stepId === 'profileSummary';
    const loadingLabel = stepId ? NEXT_STEP_LOADING_LABEL[stepId] : undefined;
    const loadingRow = !isEligibilityCompute && loadingLabel ? this.showLoadingRow(loadingLabel) : null;
    const skeletonCard = isEligibilityCompute ? this.showSkeletonCard() : null;
    try {
      const resp = await this.api.send({ sessionToken: this.sessionToken!, stepId, value });
      loadingRow?.remove();
      skeletonCard?.remove();
      await this.renderTurn(resp);
    } catch (err) {
      loadingRow?.remove();
      skeletonCard?.remove();
      if (err instanceof SessionExpiredError) {
        localStorage.removeItem(STORAGE_KEY);
        this.sessionToken = null;
        this.chatLogEl.innerHTML = '';
        return this.start();
      }
      this.renderFatalError();
    }
  }

  private renderFatalError() {
    this.clearComposer();
    const row = document.createElement('div');
    row.className = 'lc-row lc-bot';
    row.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-bubble">Sorry, something went wrong on our end. Please try again in a moment.</div>`;
    this.chatLogEl.appendChild(row);
    const btn = document.createElement('button');
    btn.className = 'lc-ghost-btn';
    btn.textContent = 'Retry';
    btn.onclick = () => this.start();
    this.composerEl.appendChild(btn);
  }

  private restart() {
    localStorage.removeItem(STORAGE_KEY);
    this.sessionToken = null;
    this.resultCardShown = false;
    this.resultCollapsed = false;
    this.panOfferOffered = false;
    this.panOfferNeedsMobile = false;
    this.panOfferResolved = null;
    this.statusActionsShown = false;
    this.chatLogEl.innerHTML = '';
    void this.start();
  }

  /** Lets the customer collapse the (potentially long) result card into a one-line pill and bring
   * it back later without losing it or re-fetching anything — both elements already exist in the
   * DOM (rendered by renderResultCard), this just toggles which one is visible. Also restores
   * whichever state was active before a profile-panel edit re-rendered the card's contents. */
  private wireResultMinimize() {
    const expanded = this.resultContainerEl.querySelector<HTMLElement>('#lc-result-expanded');
    const pill = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-result-pill');
    const minimizeBtn = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-btn-minimize');
    if (!expanded || !pill || !minimizeBtn) return;

    expanded.style.display = this.resultCollapsed ? 'none' : 'block';
    pill.style.display = this.resultCollapsed ? 'flex' : 'none';

    minimizeBtn.onclick = () => {
      this.resultCollapsed = true;
      expanded.style.display = 'none';
      pill.style.display = 'flex';
    };
    pill.onclick = () => {
      this.resultCollapsed = false;
      pill.style.display = 'none';
      expanded.style.display = 'block';
    };
  }

}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
