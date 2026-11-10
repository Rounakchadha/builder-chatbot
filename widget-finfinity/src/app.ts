import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse, type InputSpec } from '@builder-chatbot/shared';
import { ChatApi, SessionExpiredError, describeApiError } from './api';
import finfinityLogo from './assets/finfinity-logo.svg?raw';
import { ICON } from './icons';
import { ProfilePanel } from './profilePanel';
import { renderResultCard, rmCardHtml, lenderThankYouHtml } from './resultCard';
// `?inline` gets the fully-processed CSS (Tailwind included) as a plain string instead of Vite
// auto-injecting it into the host page's <head> — we inject it ourselves into a shadow root
// instead, so none of it (including Tailwind's global Preflight reset) ever touches the host
// page's own elements, and none of the host page's own global CSS leaks in either.
import widgetStyles from './style.css?inline';

// Security-review finding, 2026-10-23: localStorage throws in Safari private browsing (and can
// throw under some locked-down browser/extension policies) — every call here used to assume it
// always just works, which would crash widget init outright in those cases. A failed read/write is
// treated as "nothing stored" / "couldn't persist", never a crash.
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted this time — the customer just re-answers on their next visit, same as a first-time visitor.
  }
}
function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clean up if it was never written in the first place.
  }
}

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
  // PAN is never asked again in Business Loan (2026-10-21 instruction) — blLoanPurpose leads
  // straight into blPanAutoFill (silent) then blGstLookup's real API call, so this is the one spot
  // that needs a spinner label or that whole gap would show nothing at all until the GST
  // question/offers finally appeared.
  blLoanPurpose: 'Looking up your business details…',
  // 'profileSummary' (Home Loan/LAP) and 'glProfileSummary' (Gold Loan) aren't here — they get the
  // dedicated skeleton card (showSkeletonCard) instead, since those compute a real eligibility
  // amount. Business Loan/LAS never compute one at all (lead-only, no eligibility/offers — see
  // businessLoan.ts/loanAgainstShares.ts's own doc comments), so that skeleton's amount+stats shape
  // would visually promise a number that never appears — this plainer spinner is the right fit
  // instead (2026-10-21 — previously showed nothing at all here).
  blProfileSummary: 'Submitting your application…',
  lasProfileSummary: 'Submitting your application…',
};

export interface ChatWidgetOptions {
  apiBaseUrl: string;
  mountTo?: HTMLElement; // defaults to document.body
  /** Skips rendering the widget's own floating round launcher button — for a host page that
   * already has its own chat-entry-point UI and wants to open this widget from that instead (see
   * the public `open()` method below). The panel itself still renders normally once opened. */
  hideLauncher?: boolean;
  /** Re-skins the widget to match a host site's own brand (2026-10-23) — a plain map of this
   * widget's own PUBLIC theme tokens (see style.css's `.lc-root` for the full `--lc-theme-*` list —
   * bg/panel/panel-raised/primary/primary-dim/primary-ink/ink/user-bubble/font — plus the launcher's
   * own `--lc-launcher-bottom`/`-right`/`-left`) to the values that site wants, e.g.
   * `{ '--lc-theme-primary': '#945ef0', '--lc-theme-font': 'Poppins, sans-serif', '--lc-launcher-right': '96px' }`.
   * Anything left out keeps its existing default — this is purely additive, so a host that never
   * sets this gets pixel-identical output to before this option existed. Applied as inline styles
   * on the widget's own mount point (never the host page), so it can never leak into or affect
   * anything else on that page. */
  theme?: Record<string, string>;
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

  /** Bumped before every chat-affecting request (main send path, restart) — security-review
   * finding, 2026-10-23: a response landing after a newer one started (e.g. "Start over" clicked
   * while a reply was still in flight) used to just overwrite whatever the newer request had
   * already rendered. A request only applies its result if this counter still matches the value it
   * captured when it started. */
  private requestGen = 0;
  /** Caps how many times start() can recurse on a SessionExpiredError in a row — without this, a
   * permanently-invalid stored identity token could make it call itself forever (security-review
   * finding, 2026-10-23). */
  private startRetryCount = 0;
  private hostEl: HTMLElement | null = null;
  private cleanupFns: Array<() => void> = [];
  /** Set only by a launchToken passed into open() — a one-time, server-to-server-issued value (see
   * externalLaunch.service.ts), never persisted to localStorage like STORAGE_KEY/IDENTITY_STORAGE_KEY
   * above, since it's single-use and tied to this one open() call, not something to resume later. */
  private launchToken: string | null = null;

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
    this.sessionToken = safeGetItem(STORAGE_KEY);
    this.buildDom();
  }

  private buildDom() {
    // A shadow root gives full style encapsulation in both directions — the host page's global
    // CSS (resets, frameworks, its own Tailwind build) can't reach in, and nothing in here
    // (Tailwind's Preflight included) can leak out onto the host page. See widgetStyles above.
    const host = document.createElement('div');
    // Custom properties inherit through a shadow boundary even though regular styles don't, so
    // setting these here (on the LIGHT-DOM host, before the shadow root even exists) is enough for
    // style.css's `var(--lc-x, <default>)` tokens inside the shadow tree to pick them up — see
    // ChatWidgetOptions.theme's own doc comment for why this is safe to leave unset.
    if (this.opts.theme) {
      for (const [prop, value] of Object.entries(this.opts.theme)) host.style.setProperty(prop, value);
    }
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
    if (this.opts.hideLauncher) launcher.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'lc-panel';
    // Accessibility (security-review finding, 2026-10-23): this panel is a full-screen modal overlay
    // with no dialog semantics at all before this — a screen reader had no way to know it was a
    // dialog, or that content inside it was the only thing that mattered while open.
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Loan eligibility assistant');
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
          <!-- A direct sibling of -left/-right (not nested inside -right) so the mobile media
               query can force it onto its own full-width, centered row below both — see
               .lc-progress-wrap's mobile rule. On desktop this sits exactly where it always did,
               between the logo and the buttons, same visual order as before. -->
          <div class="lc-progress-wrap">
            <div class="lc-progress-label">
              <span class="lc-progress-step">Getting started</span>
              <span class="lc-progress-pct"></span>
            </div>
            <div class="lc-progress-track"><div class="lc-progress-fill"></div></div>
          </div>
          <div class="lc-masthead-right">
            <button class="lc-start-over" type="button">${ICON.restart} <span>Start over</span></button>
            <!-- Mobile-only — see .lc-sidebar-toggle's media query. Desktop keeps the sidebar
                 permanently docked (no toggle needed there at all). -->
            <button class="lc-sidebar-toggle" type="button" aria-label="View your details">${ICON.user}</button>
            <button class="lc-close" aria-label="Close chat">${ICON.close}</button>
          </div>
        </div>
      </div>
      <div class="lc-content-row">
        <div class="lc-body">
          <div class="lc-chat-log"></div>
          <div class="lc-composer"></div>
        </div>
        <!-- Mobile-only backdrop behind the sidebar-as-drawer — see .lc-sidebar-backdrop's media query. -->
        <div class="lc-sidebar-backdrop"></div>
        <aside class="lc-sidebar">
          <div class="lc-sidebar-header">
            <div>
              <div class="lc-sidebar-title">Your details</div>
              <div class="lc-sidebar-subtitle">Saved automatically as you go</div>
            </div>
            <button class="lc-sidebar-close" type="button" aria-label="Close">${ICON.close}</button>
          </div>
          <div class="lc-sidebar-fields"></div>
        </aside>
      </div>
    `;
    panel.querySelector<HTMLButtonElement>('.lc-close')!.onclick = () => this.toggle(false);
    panel.querySelector<HTMLButtonElement>('.lc-start-over')!.onclick = () => {
      if (confirm('Start a new eligibility check? This will discard your current progress.')) this.restart();
    };

    // Mobile only (see CSS) — on desktop the sidebar is always visible and these three elements
    // are display:none, so this wiring is simply inert there.
    const sidebarEl = panel.querySelector<HTMLElement>('.lc-sidebar')!;
    const sidebarBackdropEl = panel.querySelector<HTMLElement>('.lc-sidebar-backdrop')!;
    const openSidebar = () => {
      sidebarEl.classList.add('lc-sidebar-open');
      sidebarBackdropEl.classList.add('lc-sidebar-open');
    };
    const closeSidebar = () => {
      sidebarEl.classList.remove('lc-sidebar-open');
      sidebarBackdropEl.classList.remove('lc-sidebar-open');
    };
    panel.querySelector<HTMLButtonElement>('.lc-sidebar-toggle')!.onclick = openSidebar;
    panel.querySelector<HTMLButtonElement>('.lc-sidebar-close')!.onclick = closeSidebar;
    sidebarBackdropEl.onclick = closeSidebar;

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
    // Screen readers announce new bot messages as they arrive (security-review finding, 2026-10-23
    // — there was no aria-live region at all, so a screen-reader user got no indication a reply had
    // come in beyond re-scanning the whole log).
    this.chatLogEl.setAttribute('aria-live', 'polite');
    this.composerEl = panel.querySelector('.lc-composer')!;
    this.progressFillEl = panel.querySelector('.lc-progress-fill')!;
    this.progressStepEl = panel.querySelector('.lc-progress-step')!;
    this.progressPctEl = panel.querySelector('.lc-progress-pct')!;

    panel.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.toggle(false);
        return;
      }
      if (e.key === 'Tab') this.trapFocus(e);
    });

    root.appendChild(panel);
    root.appendChild(launcher);
    shadow.appendChild(root);
    this.hostEl = host;
    (this.opts.mountTo ?? document.body).appendChild(host);
  }

  /** Minimal manual focus trap (security-review finding, 2026-10-23: Tab could escape the panel
   * into the host page behind it while the dialog was open) — wraps Tab/Shift+Tab at the panel's
   * first/last focusable elements back around instead of letting focus leave. */
  private trapFocus(e: KeyboardEvent) {
    const focusable = Array.from(
      this.panelEl.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = this.panelEl.getRootNode() instanceof ShadowRoot ? (this.panelEl.getRootNode() as ShadowRoot).activeElement : document.activeElement;
    if (e.shiftKey && activeEl === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Opens the panel from outside — for a host page that passed `hideLauncher: true` and wants to
   * trigger this widget from its own existing chat-entry-point UI instead of this widget's launcher. */
  /** `launchToken` (2026-11-02, UAT SDK — see externalLaunch.service.ts): Finfinity's OWN app's
   * frontend gets this from its own backend's call to POST /api/external/sessions, then passes it
   * straight here when opening the widget — pre-filling product/mobile/email so the customer isn't
   * asked for what that app already knows. Only read if this is the very first start() this
   * instance makes (no stored sessionToken yet); ignored on every later open() call in the same
   * page session, same as identityToken/STORAGE_KEY never resetting mid-session. */
  open(launchToken?: string): void {
    if (launchToken) this.launchToken = launchToken;
    this.toggle(true);
  }

  private toggle(force?: boolean) {
    const open = force ?? !this.panelEl.classList.contains('lc-open');
    this.panelEl.classList.toggle('lc-open', open);
    this.launcherEl.classList.toggle('lc-launcher-open', open);
    // Body-scroll-lock (security-review finding, 2026-10-23) — the panel is a full-screen overlay
    // (z-index: 999999; inset: 0), but the host page behind it could still scroll while it was open.
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      const firstFocusable = this.panelEl.querySelector<HTMLElement>('input, button:not([disabled])');
      firstFocusable?.focus();
    }
    if (open && !this.started) {
      this.started = true;
      void this.start();
    }
  }

  /** Tears down this widget instance — removes its DOM (including the shadow root) and clears any
   * intervals it registered, so a host page that re-inits (e.g. an SPA route change, or a second
   * copy of the embed script running by accident) doesn't end up with two overlapping instances or
   * an orphaned timer still ticking in the background (security-review finding, 2026-10-23). */
  destroy(): void {
    document.body.style.overflow = '';
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns = [];
    this.hostEl?.remove();
    this.hostEl = null;
  }

  private async start(): Promise<void> {
    const gen = ++this.requestGen;
    try {
      const resp = this.sessionToken
        ? await this.api.send({ sessionToken: this.sessionToken })
        : await this.api.send({ identityToken: safeGetItem(IDENTITY_STORAGE_KEY) ?? undefined, launchToken: this.launchToken ?? undefined });
      if (gen !== this.requestGen) return; // a newer request (e.g. Start over) began while this one was in flight
      this.startRetryCount = 0;
      this.sessionToken = resp.sessionToken;
      safeSetItem(STORAGE_KEY, resp.sessionToken);
      await this.renderTurn(resp);
    } catch (err) {
      if (gen !== this.requestGen) return;
      if (err instanceof SessionExpiredError) {
        // Capped (security-review finding, 2026-10-23) — a permanently-invalid stored identity
        // token could otherwise make this recurse forever, each attempt failing the same way.
        if (this.startRetryCount >= 1) {
          this.renderFatalError('This session could not be restored. Please refresh the page and try again.');
          return;
        }
        this.startRetryCount++;
        safeRemoveItem(STORAGE_KEY);
        this.sessionToken = null;
        return this.start();
      }
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'));
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
    if (resp.identityToken) safeSetItem(IDENTITY_STORAGE_KEY, resp.identityToken);

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
      // A result-type terminal step is always flagged loading server-side (checked via resp.done,
      // not stepId === 'result', since Personal/Gold/Business loan each have their own terminal
      // step id — plResult/glResult/blResult, not literally 'result' — but all of them set done:true
      // the same way the original 'result' step does), but by the time it gets here the real wait
      // already happened (the skeleton card covered it) — layering on this decorative 900ms-minimum
      // spinner too would just add a second, pointless loading moment right after the first one,
      // which is exactly the "loader still showed after the skeleton" complaint.
      if (resp.loading && !resp.done) {
        await this.appendLoadingThenBot(LOADING_LABEL[resp.stepId] ?? 'One moment…', resp.botMessage, resp.hint);
      } else {
        await this.appendBotBubble(resp.botMessage, resp.hint);
      }
    }

    if (resp.done) {
      // The result card is built once; a later message sent from the persistent chat bar below it
      // (a follow-up question, small talk, etc.) comes back with done:true too, but we just show
      // the reply above and leave the card + chat bar exactly as they are — never rebuild them.
      // Checked by resp.result being present (not by stepId === 'result') because Personal/Gold/
      // Business loan each have their own terminal step id (plResult/glResult/blResult) — the
      // server only ever populates `result` for an actual result-type step regardless of its id
      // (see routes/chat.ts's render()), so this check alone is the right generic signal.
      const isFirstResultRender = resp.done && Boolean(resp.result) && !this.resultCardShown;
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
    this.resultContainerEl.innerHTML = renderResultCard(result as any, this.opts.apiBaseUrl);
    const restartBtn = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-btn-restart');
    if (restartBtn) restartBtn.onclick = () => this.restart();
    this.wireResultMinimize();
    this.wireLenderToggles();
    this.wireGoldSubmitCard();
    this.wireSelectOfferButtons();
    this.renderPanOffer();
  }

  /** "Select this offer" buttons on HL/LAP's lender-detail breakdown and Personal Loan's lender
   * cards (see resultCard.ts) — calls the real setbrefinanceroffertenure (2026-10-15, see
   * routes/chat.ts's select-offer endpoint). Personal Loan's real lead now already exists by this
   * point (created automatically the moment eligibility is shown — see personalLoan.ts's
   * plCreateLead step, 2026-10-16), so its RM card is already real here; this click only records
   * the chosen tenure, same as HL/LAP. */
  private wireSelectOfferButtons() {
    this.resultContainerEl.querySelectorAll<HTMLButtonElement>('[data-select-offer]').forEach((btn) => {
      const lenderName = btn.dataset.selectOffer!;
      const plCard = btn.closest<HTMLElement>('[data-pl-lender-card]');
      btn.onclick = async (e) => {
        e.stopPropagation(); // don't also trigger the parent lender-row's expand/collapse toggle
        const slot = btn.closest<HTMLElement>('[data-select-offer-slot]');
        btn.disabled = true;
        btn.textContent = 'Selecting…';
        let result: Awaited<ReturnType<ChatApi['selectOffer']>>;
        try {
          result = await this.api.selectOffer(this.sessionToken!, lenderName);
        } catch (err) {
          if (slot) slot.innerHTML = `<div class="lc-gold-submit-confirmed">${describeApiError(err, "Couldn't select this offer right now — please try again shortly.")}</div>`;
          return;
        }
        if (!slot) return;
        if (result.ok) {
          // Bug fixed 2026-11-02 ("edit still appears to work right after selecting an offer"):
          // select-offer locks the backend immediately (applicationSubmitted), but the sidebar's
          // Edit buttons were left in their stale pre-selection state until the next full reload —
          // refresh it now so they visibly disable too, not just reject the save server-side.
          void this.profilePanel.refresh();
          if (plCard) {
            // Personal Loan: once one offer is picked, the others no longer matter — hide every
            // other lender card, the "highest eligibility" summary above them (it compared offers
            // that are no longer relevant now that one's chosen), and replace just this card with a
            // plain thank-you message, naming the RM already shown in the RM card above (real since
            // plCreateLead ran).
            const rmName = this.resultContainerEl.querySelector('#lc-rm-card .lc-rm-name')?.textContent?.split('·')[0]?.trim();
            const highestEligibility = this.resultContainerEl.querySelector<HTMLElement>('#lc-pl-highest-eligibility');
            if (highestEligibility) highestEligibility.style.display = 'none';
            plCard.parentElement?.querySelectorAll<HTMLElement>('[data-pl-lender-card]').forEach((card) => {
              if (card !== plCard) card.style.display = 'none';
            });
            plCard.innerHTML = lenderThankYouHtml(lenderName, this.opts.apiBaseUrl, rmName);
          } else {
            // Home Loan/LAP: same "nothing else matters once one's picked" treatment as Personal
            // Loan — hide the "highest eligibility" summary and its label, and collapse the whole
            // accordion of lender rows down to a single thank-you card in its place.
            const rmName = this.resultContainerEl.querySelector('#lc-rm-card .lc-rm-name')?.textContent?.split('·')[0]?.trim();
            const highestEligibility = this.resultContainerEl.querySelector<HTMLElement>('#lc-highest-eligibility');
            const lenderListLabel = this.resultContainerEl.querySelector<HTMLElement>('#lc-eligibility-by-lender-label');
            const lenderList = this.resultContainerEl.querySelector<HTMLElement>('#lc-lender-list');
            if (highestEligibility) highestEligibility.style.display = 'none';
            if (lenderListLabel) lenderListLabel.style.display = 'none';
            if (lenderList) lenderList.innerHTML = lenderThankYouHtml(lenderName, this.opts.apiBaseUrl, rmName);
          }
        } else {
          slot.innerHTML = `<div class="lc-gold-submit-confirmed">Couldn't select this offer right now — please try again shortly.</div>`;
        }
      };
    });
  }

  /** Gold loan's "submit to lender" card (see resultCard.ts's goldSubmitCardHtml) — now calls the
   * real backend (2026-10-15, see services/goldLoan.service.ts's muthootleadgeneration), which can
   * fail (e.g. the customer already has an active Muthoot application) instead of always
   * succeeding like the old client-side-only version did. */
  private wireGoldSubmitCard() {
    const card = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-gold-submit-card');
    if (!card) return;
    card.onclick = async () => {
      const lender = card.dataset.lender ?? 'the lender';
      const amountLakh = card.dataset.amountLakh;
      const amountText = amountLakh ? `₹${amountLakh} lakh` : 'this amount';
      const slot = this.resultContainerEl.querySelector<HTMLElement>('#lc-gold-submit-slot');
      card.disabled = true;
      let result: Awaited<ReturnType<ChatApi['goldSubmit']>>;
      try {
        result = await this.api.goldSubmit(this.sessionToken!);
      } catch (err) {
        if (slot) slot.innerHTML = `<div class="lc-gold-submit-confirmed">${describeApiError(err, "Couldn't submit this application right now — please try again shortly.")}</div>`;
        return;
      }
      if (!slot) return;
      // Swap the placeholder RM (glResult's own pickRm — Gold Loan defers real lead creation until
      // this exact click) for the real one as soon as we have it — a real lead, and therefore a
      // real RM, can exist even when the Muthoot-specific step itself reports a failure or "already
      // exists" (2026-10-21 bug fix: this used to only run inside the result.ok branch, so a
      // perfectly real RM returned alongside a non-ok result — e.g. "You already have an active
      // Muthoot application" — was silently discarded and the fake placeholder RM kept showing).
      if (result.rm) {
        const rmCard = this.resultContainerEl.querySelector<HTMLElement>('#lc-rm-card');
        const leadIdMatch = rmCard?.textContent?.match(/Lead ID:\s*(\S+)/);
        if (rmCard) rmCard.outerHTML = rmCardHtml(result.rm, result.leadId ?? leadIdMatch?.[1]);
      }
      if (result.ok) {
        slot.innerHTML = `<div class="lc-gold-submit-confirmed">${ICON.check} Your application has been submitted to <strong>${lender}</strong> for ${amountText}.</div>`;
      } else {
        slot.innerHTML = `<div class="lc-gold-submit-confirmed">${result.message ?? "Couldn't submit this application right now — please try again shortly."}</div>`;
      }
    };
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
             <input class="lc-input" id="lc-pan-offer-mobile" type="text" placeholder="10-digit mobile number" maxlength="10" style="margin-bottom:8px">`
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
    let outcome: Awaited<ReturnType<ChatApi['panOffer']>>;
    try {
      outcome = await this.api.panOffer(this.sessionToken!, opts);
    } catch (err) {
      const errEl = this.resultContainerEl.querySelector<HTMLElement>('#lc-pan-offer-error');
      if (errEl) {
        errEl.textContent = describeApiError(err, 'Something went wrong — please try again.');
        errEl.style.display = 'block';
      }
      return;
    }
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
        // Deliberately plain type="text" with no inputMode — a "tel"/numeric-mode field pops the
        // phone dial-pad keyboard on mobile, which has no letters at all. The customer never needs
        // letters here, but a full text keyboard still lets them see what they've typed normally
        // (dial-pad-only UIs render digits oddly on some devices) — only OTP entry keeps the
        // numeric keypad (2026-10-16 direct instruction).
        this.renderChatBar(resp.stepId, { type: 'text', maxLength: 10, placeholder: 'Type your 10-digit mobile number…' });
        break;
      case 'pan':
        this.renderChatBar(resp.stepId, { type: 'text', maxLength: 10, placeholder: 'Type your PAN, e.g. ABCDE1234F…', uppercase: true });
        break;
      case 'number':
        // Deliberately type="text" with no inputMode — a native number input blocks typing words
        // like "no"/"none"/"85k" (the server's parseAmount understands those), and a numeric/decimal
        // inputMode pops a number-only keypad on mobile. Full text keyboard for every one of these,
        // same as every other non-OTP field (2026-10-16 direct instruction).
        this.renderChatBar(resp.stepId, { type: 'text', placeholder: input.placeholder ? `Type ${input.placeholder}…` : 'Type your answer…' });
        break;
      case 'text':
        this.renderChatBar(resp.stepId, {
          type: 'text',
          placeholder: input.placeholder ? `Type ${input.placeholder}…` : 'Type your answer…',
          maxLength: input.maxLength,
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
        // Deliberately NOT a native <input type="date"> — that renders in whatever format the
        // browser/OS locale dictates (mm/dd/yyyy, dd-mm-yyyy, etc.), which no amount of HTML/CSS
        // can override. Three explicit dropdowns guarantee DD/MM/YYYY everywhere regardless of
        // locale (2026-10-17 instruction).
        this.renderDateComposer(resp.stepId, input.max);
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
    this.requestGen++; // invalidate anything still in flight from before this restart
    this.startRetryCount = 0;
    const gen = this.requestGen;
    safeRemoveItem(STORAGE_KEY);
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
      if (gen !== this.requestGen) return;
      this.sessionToken = start.sessionToken;
      safeSetItem(STORAGE_KEY, start.sessionToken);
      const answered = await this.api.send({ sessionToken: this.sessionToken, stepId: 'intent', value: intent });
      if (gen !== this.requestGen) return;
      await this.renderTurn(answered);
    } catch (err) {
      if (gen !== this.requestGen) return;
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'));
    }
  }

  /** Three explicit Day/Month/Year dropdowns, always in that order — guarantees a DD/MM/YYYY look
   * regardless of browser/OS locale, which a native <input type="date"> can't promise (its display
   * format follows the user's locale, not our markup). Day options are regenerated whenever month
   * or year changes, so a leap-year Feb 29 only ever appears when it's real — a native select
   * can't silently roll over an invalid date the way `new Date(y, m, 32)` would. */
  private renderDateComposer(stepId: string, max?: string) {
    const wrap = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'lc-field-label';
    l.textContent = 'Date (DD/MM/YYYY)';
    wrap.appendChild(l);

    const row = document.createElement('div');
    row.className = 'lc-date-row';

    const maxDate = max ? new Date(`${max}T00:00:00`) : undefined;
    const maxYear = maxDate?.getFullYear() ?? new Date().getFullYear();
    const EARLIEST_YEAR = maxYear - 150;

    const daySelect = document.createElement('select');
    daySelect.className = 'lc-date-select lc-date-select-day';
    const monthSelect = document.createElement('select');
    monthSelect.className = 'lc-date-select lc-date-select-month';
    const yearSelect = document.createElement('select');
    yearSelect.className = 'lc-date-select lc-date-select-year';

    const addPlaceholder = (select: HTMLSelectElement, text: string) => {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = text;
      opt.disabled = true;
      opt.selected = true;
      select.appendChild(opt);
    };

    addPlaceholder(daySelect, 'DD');
    addPlaceholder(monthSelect, 'MM');
    addPlaceholder(yearSelect, 'YYYY');

    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = String(m).padStart(2, '0');
      opt.textContent = String(m).padStart(2, '0');
      monthSelect.appendChild(opt);
    }
    for (let y = maxYear; y >= EARLIEST_YEAR; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSelect.appendChild(opt);
    }

    const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

    const refreshDayOptions = () => {
      const previousDay = daySelect.value;
      const year = Number(yearSelect.value) || new Date().getFullYear();
      const month = Number(monthSelect.value) || 1;
      const total = daysInMonth(year, month);
      while (daySelect.options.length > 1) daySelect.remove(1);
      for (let d = 1; d <= total; d++) {
        const opt = document.createElement('option');
        opt.value = String(d).padStart(2, '0');
        opt.textContent = String(d).padStart(2, '0');
        daySelect.appendChild(opt);
      }
      // Keep whatever day was already picked if it's still valid for the new month (e.g. switching
      // Jan 31 -> Feb just drops back to the placeholder instead of silently becoming Feb 28).
      if (previousDay && Number(previousDay) <= total) daySelect.value = previousDay;
    };
    refreshDayOptions();
    monthSelect.addEventListener('change', refreshDayOptions);
    yearSelect.addEventListener('change', refreshDayOptions);

    row.appendChild(daySelect);
    row.appendChild(monthSelect);
    row.appendChild(yearSelect);
    wrap.appendChild(row);

    const errorEl = document.createElement('div');
    errorEl.className = 'lc-date-error';
    errorEl.style.display = 'none';
    wrap.appendChild(errorEl);

    const btn = document.createElement('button');
    btn.className = 'lc-primary-btn';
    btn.textContent = 'Continue';
    btn.onclick = () => {
      if (!daySelect.value || !monthSelect.value || !yearSelect.value) {
        errorEl.textContent = 'Pick a day, month, and year.';
        errorEl.style.display = 'block';
        return;
      }
      const iso = `${yearSelect.value}-${monthSelect.value}-${daySelect.value}`;
      if (maxDate && new Date(`${iso}T00:00:00`) > maxDate) {
        errorEl.textContent = "That date can't be in the future.";
        errorEl.style.display = 'block';
        return;
      }
      this.submitUserValue(stepId, iso, `${daySelect.value}/${monthSelect.value}/${yearSelect.value}`);
    };
    wrap.appendChild(btn);

    this.composerEl.appendChild(wrap);
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

    const RESEND_COOLDOWN_SECONDS = 30;
    const resend = document.createElement('button');
    resend.className = 'lc-ghost-btn';
    let cooldownTimer: ReturnType<typeof setInterval> | undefined;
    this.cleanupFns.push(() => clearInterval(cooldownTimer));

    // An OTP was just sent to land on this step, so resend starts on cooldown rather than
    // immediately clickable — ticks down once a second until it's enabled.
    const startCooldown = (seconds: number) => {
      clearInterval(cooldownTimer);
      let remaining = seconds;
      resend.disabled = true;
      resend.textContent = `Resend OTP (${remaining}s)`;
      cooldownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(cooldownTimer);
          resend.disabled = false;
          resend.textContent = 'Resend OTP';
          return;
        }
        resend.textContent = `Resend OTP (${remaining}s)`;
      }, 1000);
    };

    resend.onclick = async () => {
      clearInterval(cooldownTimer);
      resend.disabled = true;
      resend.textContent = 'Sending…';
      try {
        const result = await this.api.resendOtp(this.sessionToken!);
        if ('ok' in result) {
          await this.appendBotBubble("I've sent you a new OTP.");
        } else {
          await this.appendBotBubble(result.message ?? "Couldn't resend the OTP right now — please try again shortly.");
        }
      } catch (err) {
        await this.appendBotBubble(describeApiError(err, "Couldn't resend the OTP right now — please try again shortly."));
      }
      // Restart the cooldown either way — a failure here almost always means a cooldown (ours or
      // the real backend's) is still active, so immediately re-enabling would just fail again.
      startCooldown(RESEND_COOLDOWN_SECONDS);
    };
    wrap.appendChild(resend);
    startCooldown(RESEND_COOLDOWN_SECONDS);

    // Lets a customer back out of a typo'd mobile number before ever verifying it — only makes
    // sense on the very first OTP (otpDedupe verifies the mobile number itself); every other OTP
    // step this same composer renders for (bureau consent, PAN/email duplicate-verify) is either
    // re-confirming an already-verified number or one the customer doesn't own to begin with, so
    // "edit it" would be meaningless there. There's no partial "go back one step" in this engine
    // (it only ever walks forward), so this is a full restart under the hood — safe with no
    // confirmation this early, since at most an intent choice is lost (2026-10-17 instruction).
    if (stepId === 'otpDedupe') {
      const editNumber = document.createElement('button');
      editNumber.className = 'lc-ghost-btn';
      editNumber.textContent = 'Wrong number? Edit it';
      editNumber.onclick = () => this.restart();
      wrap.appendChild(editNumber);
    }

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
    // Home Loan/LAP's own terminal "about to compute eligibility" step is literally 'profileSummary'
    // — Gold Loan's equivalent (right before glResult) is glProfileSummary, which never got this
    // skeleton treatment at all until now (2026-10-21 — reported showing nothing here). Business
    // Loan/LAS have their own equivalents too (blProfileSummary/lasProfileSummary) but their result
    // is a lead-only confirmation with no eligibility amount ever shown — this skeleton's shape
    // (an amount bar + stat grid) would visually promise a number that never actually appears for
    // them, so left as plain message steps for those two rather than reusing a mismatched skeleton.
    const isEligibilityCompute = stepId === 'profileSummary' || stepId === 'glProfileSummary';
    const loadingLabel = stepId ? NEXT_STEP_LOADING_LABEL[stepId] : undefined;
    const loadingRow = !isEligibilityCompute && loadingLabel ? this.showLoadingRow(loadingLabel) : null;
    const skeletonCard = isEligibilityCompute ? this.showSkeletonCard() : null;
    const gen = ++this.requestGen;
    try {
      const resp = await this.api.send({ sessionToken: this.sessionToken!, stepId, value });
      if (gen !== this.requestGen) return; // a newer request (e.g. Start over) began while this one was in flight — discard this stale reply
      loadingRow?.remove();
      skeletonCard?.remove();
      await this.renderTurn(resp);
    } catch (err) {
      if (gen !== this.requestGen) return;
      loadingRow?.remove();
      skeletonCard?.remove();
      if (err instanceof SessionExpiredError) {
        safeRemoveItem(STORAGE_KEY);
        this.sessionToken = null;
        this.chatLogEl.innerHTML = '';
        return this.start();
      }
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'));
    }
  }

  private renderFatalError(message = 'Sorry, something went wrong on our end. Please try again in a moment.') {
    this.clearComposer();
    const row = document.createElement('div');
    row.className = 'lc-row lc-bot';
    row.innerHTML = `<div class="lc-avatar">${ICON.bot}</div><div class="lc-bubble"></div>`;
    row.querySelector('.lc-bubble')!.textContent = message;
    this.chatLogEl.appendChild(row);
    const btn = document.createElement('button');
    btn.className = 'lc-ghost-btn';
    btn.textContent = 'Retry';
    btn.onclick = () => this.start();
    this.composerEl.appendChild(btn);
  }

  private restart() {
    // Invalidate any request still in flight from before this restart (security-review finding,
    // 2026-10-23) — without this, a reply to the OLD conversation could land right after and
    // overwrite the freshly-reset screen with stale content.
    this.requestGen++;
    this.startRetryCount = 0;
    safeRemoveItem(STORAGE_KEY);
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
