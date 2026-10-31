import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse, type InputSpec } from '@builder-chatbot/shared';
import { ChatApi, SessionExpiredError, describeApiError } from './api';
import { cisLogo } from './cisLogo';
// The finfinity wordmark's own fill colors (white text, teal accents) assume a dark background —
// inlined raw (not as an <img src>) so it can sit inside a small dark chip in the otherwise-light
// CIS header, matching the "Powered by finfinity" treatment already in the sidebar footer but with
// the actual logo mark, not just text (2026-10-30 direct instruction).
import finfinityLogoSvg from './assets/finfinity-logo.svg?raw';
import { ICON } from './icons';
import { ProfilePanel } from './profilePanel';
import { renderResultCard, rmCardHtml, lenderThankYouHtml } from './resultCard';
// `?inline` gets the fully-processed CSS (Tailwind included) as a plain string instead of Vite
// auto-injecting it into the host page's <head> — we inject it ourselves into a shadow root
// instead, so none of it (including Tailwind's global Preflight reset) ever touches the host
// page's own elements, and none of the host page's own global CSS leaks in either.
import widgetStyles from './style.css?inline';

// Register --la-orbit at document level so shadow-DOM CSS can animate the travelling border beam.
if (typeof document !== 'undefined') {
  if (typeof CSS !== 'undefined' && 'registerProperty' in CSS) {
    try {
      CSS.registerProperty({
        name: '--la-orbit',
        syntax: '<angle>',
        inherits: true,
        initialValue: '0deg',
      });
    } catch {
      // already registered
    }
  }
  if (document.head && !document.getElementById('cis-beam-property')) {
    const s = document.createElement('style');
    s.id = 'cis-beam-property';
    s.textContent = '@property --la-orbit { syntax: "<angle>"; inherits: true; initial-value: 0deg; }';
    document.head.appendChild(s);
  }
}

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
  // Shows expanded automatically (reverted 2026-10-30 — a same-day earlier change made this start
  // collapsed behind a click-to-reveal pill; the user tested that live and wants results to just
  // appear directly instead, no extra click). The per-lender row accordion is unaffected.
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

  private panelEl!: HTMLDivElement;
  private rootEl!: HTMLDivElement;
  private themeButtons!: NodeListOf<HTMLButtonElement>;
  private launcherEl!: HTMLButtonElement;
  private bodyEl!: HTMLDivElement;
  private chatLogEl!: HTMLDivElement;
  private composerEl!: HTMLDivElement;
  private resultContainerEl!: HTMLDivElement;
  private progressFillEl!: HTMLElement;
  private progressStepEl!: HTMLSpanElement;
  private progressPctEl!: HTMLSpanElement;
  private segmentsEl!: HTMLDivElement;

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
    this.rootEl = root;

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
    // Markup/classes below are copied verbatim from CIS's own design deliverables
    // (personal-suite-updated.html's #loanAssistant .la-dialog shell — see style.css's CIS
    // component CSS block, appended 2026-10-28) rather than this widget's own prior masthead/
    // sidebar markup — only the business logic (wiring below) is ours. The .la-stepper's fixed
    // 5 named stages (Getting started/Identity/Loan details/Eligibility/Complete) assume one fixed
    // flow shape, which doesn't fit this widget's several product flows (each with its own step
    // count/labels) — left out in favor of CIS's own simpler percent+label+track treatment (also
    // present in CIS's mobile file's .la-top-progress), a deliberate adaptation, not an oversight.
    panel.innerHTML = `
      <nav class="preview-bar" aria-label="Preview controls">
        <span>Count Infinity AI <small class="preview-bar-powered">Powered by finfinity</small></span>
        <div class="preview-theme" role="group" aria-label="Colour theme">
          <button type="button" data-preview-theme="cream" aria-pressed="true">Light</button>
          <button type="button" data-preview-theme="dark" aria-pressed="false">Dark</button>
        </div>
      </nav>
      <header class="la-header">
        <div class="la-brand">
          <img class="la-header-logo" src="${cisLogo}" alt="Count Infinity Services" />
          <div class="la-brand-copy">
            <h2 id="laTitle">Loan Eligibility <em>Assistant</em></h2>
            <span class="la-eyebrow">Personal Suite</span>
          </div>
        </div>
        <div class="la-header-actions">
          <div class="la-powered-badge" aria-label="Powered by finfinity">
            <span>Powered by</span>
            ${
              // The wordmark's own paths hardcode fill="white" (only ever designed to sit on the
              // old dark panel) — swapped for currentColor so `color` below can flip it to the
              // theme's own ink color (dark text in light mode, light text in dark mode), same as
              // every other piece of header text. The teal accent dots keep their real brand color.
              finfinityLogoSvg.split('fill="white"').join('fill="currentColor"')
            }
          </div>
          <button class="la-close" type="button" aria-label="Close loan assistant">${ICON.close}</button>
        </div>
      </header>
      <!-- Phone-width-only header — verbatim from CIS's apply-now-journey-2026-10-28.html's
           .convo-head.la-header (not the desktop personal-suite-updated.html one): a "Back" button
           instead of the logo/eyebrow, a plain bold title, and "Your details" shown directly in the
           header instead of tucked into the progress row. Hidden above the mobile breakpoint; the
           desktop .la-header above is hidden below it — see style.css. Back behaves the same as the
           close button (this widget has no separate "launcher" screen behind it to go back to). -->
      <header class="la-mobile-header">
        <button type="button" class="back" aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
          <span>Back</span>
        </button>
        <b>Loan Eligibility Assistant</b>
        <button type="button" class="la-mobile-details" aria-expanded="false">Your details</button>
      </header>
      <div class="la-progress-row">
        <div class="la-progress la-progress-panel">
          <div class="la-progress-copy">
            <span id="laStage" class="la-phase">GETTING STARTED</span>
            <strong id="laStep" class="la-percent">0% complete</strong>
            <button type="button" class="la-mobile-details" aria-expanded="false">Your details</button>
          </div>
          <div class="la-segments" role="progressbar" aria-label="Application progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <i style="--fill:0%"></i>
            <i style="--fill:0%"></i>
            <i style="--fill:0%"></i>
            <i style="--fill:0%"></i>
            <i style="--fill:0%"></i>
          </div>
        </div>
        <button class="la-restart la-secondary" type="button" aria-label="Start over">Start over</button>
      </div>
      <div class="la-layout">
        <div class="la-main">
          <div class="la-chat" role="log" aria-live="polite" aria-relevant="additions" aria-label="Loan conversation"></div>
          <section class="la-composer" aria-label="Your response"></section>
        </div>
        <div class="la-details-overlay">
          <button type="button" class="la-details-scrim" aria-label="Dismiss your details" tabindex="-1"></button>
          <aside class="la-sidebar" aria-label="Your details">
            <!-- Drag handle + explicit close button — CIS's real mobile file (apply-now-journey-
                 2026-10-28.html) renders this drawer as a bottom sheet with both, confirmed via its
                 own live markup/behavior (a pointerdown→pointerup gesture on the handle: dragging
                 down more than 50px closes it). Our previous version had neither and rendered the
                 drawer as a full-screen absolute overlay instead of a real bottom sheet (2026-10-30
                 fix — "should open properly ... should have a slider from where i can close it").
                 Kept as direct siblings (not wrapped in CIS's own extra .la-details-content div) so
                 every existing .la-sidebar>... CSS rule for the fields below keeps matching. -->
            <div class="la-sheet-handle" aria-hidden="true"></div>
            <button type="button" class="la-details-close" aria-label="Close your details">${ICON.close}</button>
            <h2 class="la-details-heading">Your details</h2>
            <p class="la-details-subtext">Saved automatically as you go</p>
            <div class="la-sidebar-fields"></div>
            <p class="la-powered">Powered by finfinity</p>
            <!-- Real logo version of the header's "Powered by" badge, shown only at phone width —
                 the mobile header (Back/title/Your details) has no room for it, so it lives here
                 instead, in the same "your details" drawer the mobile "Your details" button opens
                 (judgment call per direct instruction to "find space where you can put it"). -->
            <div class="la-powered-badge la-powered-badge-sidebar" aria-label="Powered by finfinity">
              <span>Powered by</span>
              ${finfinityLogoSvg.split('fill="white"').join('fill="currentColor"')}
            </div>
          </aside>
        </div>
      </div>
    `;
    panel.querySelector<HTMLButtonElement>('.la-close')!.onclick = () => this.toggle(false);
    // The phone-width header's "Back" button (CIS's apply-now-journey-2026-10-28.html) has no
    // separate screen to go back to in this widget (no standalone launcher page behind it) — it
    // does the same thing the "x" close button does on desktop.
    panel.querySelector<HTMLButtonElement>('.la-mobile-header .back')!.onclick = () => this.toggle(false);
    panel.querySelector<HTMLButtonElement>('.la-restart')!.onclick = () => {
      // A native browser confirm() can't be styled at all (2026-10-30 direct instruction — it
      // looked completely out of place against the rest of this themed UI) — a small in-panel
      // dialog instead, matching the app's own card/button language.
      this.showConfirmDialog('Start a new eligibility check?', 'This will discard your current progress.', () => this.restart());
    };

    const themeButtons = panel.querySelectorAll<HTMLButtonElement>('[data-preview-theme]');
    this.themeButtons = themeButtons;
    themeButtons.forEach((themeBtn) => {
      themeBtn.onclick = () => this.setTheme(themeBtn.dataset.previewTheme === 'dark');
    });

    // Mobile only (see CIS's own .la-sidebar/.is-open CSS) — on wider widths the sidebar is
    // always visible via the grid layout and this toggle is simply inert (hidden by CSS). Two
    // "Your details" buttons now exist in the markup (the phone-width header's, matching CIS's
    // mobile file, and the original one in the progress row) — both open/close the same drawer.
    const sidebarEl = panel.querySelector<HTMLElement>('.la-sidebar')!;
    const sidebarToggleEls = panel.querySelectorAll<HTMLButtonElement>('.la-mobile-details');
    const setSidebarOpen = (open: boolean) => {
      sidebarEl.classList.toggle('is-open', open);
      sidebarToggleEls.forEach((el) => el.setAttribute('aria-expanded', String(open)));
    };
    sidebarToggleEls.forEach((toggleEl) => {
      toggleEl.onclick = () => setSidebarOpen(!sidebarEl.classList.contains('is-open'));
    });
    // Explicit close (X) button + tapping the dimmed backdrop — both present in CIS's real mobile
    // bottom sheet, neither existed in our previous full-screen-overlay version (2026-10-30 fix).
    panel.querySelector<HTMLButtonElement>('.la-details-close')!.onclick = () => setSidebarOpen(false);
    panel.querySelector<HTMLButtonElement>('.la-details-scrim')!.onclick = () => setSidebarOpen(false);
    // Drag-handle swipe-to-close — matches CIS's own real gesture exactly (confirmed from its live
    // source): not a live-follows-your-finger drag, just "pointer went down, then came back up more
    // than 50px lower" closes the sheet.
    const handleEl = panel.querySelector<HTMLElement>('.la-sheet-handle')!;
    let dragStartY: number | null = null;
    handleEl.addEventListener('pointerdown', (e) => {
      dragStartY = e.clientY;
      handleEl.setPointerCapture(e.pointerId);
    });
    handleEl.addEventListener('pointerup', (e) => {
      if (dragStartY !== null && e.clientY - dragStartY > 50) setSidebarOpen(false);
      dragStartY = null;
    });
    handleEl.addEventListener('pointercancel', () => {
      dragStartY = null;
    });

    this.panelEl = panel;
    this.launcherEl = launcher;
    this.profilePanel = new ProfilePanel(
      panel.querySelector('.la-sidebar-fields')!,
      this.api,
      () => this.sessionToken,
      (result, messages) => void this.applyUpdatedResult(result, messages),
    );
    this.bodyEl = panel.querySelector('.la-chat')!;
    this.chatLogEl = panel.querySelector('.la-chat')!;
    this.composerEl = panel.querySelector('.la-composer')!;
    this.progressStepEl = panel.querySelector('#laStage')!;
    this.progressPctEl = panel.querySelector('#laStep')!;
    this.segmentsEl = panel.querySelector('.la-segments')!;
    this.progressFillEl = panel.querySelector('.la-track span') ?? document.createElement('span');

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
  open(): void {
    this.toggle(true);
  }

  /** Sets light/dark theme from outside — for a host page that wants its own theme toggle (e.g. a
   * landing page with "Light mode"/"Dark mode" buttons) to also drive this widget's theme, instead
   * of only the internal preview-bar buttons being able to. Mirrors exactly what those internal
   * buttons already do. */
  setTheme(isDark: boolean): void {
    this.rootEl.classList.toggle('is-dark', isDark);
    this.panelEl.classList.toggle('is-dark', isDark);
    this.themeButtons?.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.previewTheme === 'dark') === isDark)));
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
        : await this.api.send({ identityToken: safeGetItem(IDENTITY_STORAGE_KEY) ?? undefined });
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

  /** Was the customer already scrolled near the bottom before new content arrived? Call this BEFORE
   * appending anything — checking after would already include the new content's own height in the
   * gap, making a long message look like "they scrolled away" even when they were really at the
   * true bottom a moment ago. */
  private isNearBottom(thresholdPx = 120): boolean {
    return this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight < thresholdPx;
  }

  private scrollDown() {
    requestAnimationFrame(() => {
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    });
  }

  /** Auto-scroll fix (2026-10-31: "scroll up kabhi kabhi nahi horaha", "summary bohot tez neeche
   * chala jaa raha without the customer able to see it and fir scroll bhi nahi horaha") — every bot
   * reply used to force-scroll to the bottom unconditionally, fighting a customer who'd scrolled up
   * to re-read something. Only follows new content down if they were already at the bottom (same
   * pattern every normal chat app uses); a deliberate scroll-up is respected and left alone. */
  private scrollDownIfPinned(wasNearBottom: boolean) {
    if (wasNearBottom) this.scrollDown();
  }

  private scrollToResultTop() {
    requestAnimationFrame(() => {
      // Geometry-based instead of scrollIntoView (2026-10-31 fix) — scrollIntoView was confirmed
      // landing at the very BOTTOM of the chat (the RM card) instead of the result card's own top,
      // on a real deployed phone, even though the identical code reliably scrolled to the right
      // place on desktop — some nested-scroll-container quirk scrollIntoView has on mobile Safari.
      // Computing the delta via getBoundingClientRect and setting scrollTop directly (the same
      // mechanism scrollDown() above already uses, which the customer confirmed DOES work correctly
      // on the real device, just at the wrong target) sidesteps that entirely.
      const containerRect = this.resultContainerEl.getBoundingClientRect();
      const bodyRect = this.bodyEl.getBoundingClientRect();
      const delta = containerRect.top - bodyRect.top;
      this.bodyEl.scrollTop = Math.max(0, this.bodyEl.scrollTop + delta - 8);
    });
  }

  // Message markup/classes below (.la-message/.la-avatar/.la-bubble) are copied verbatim from
  // CIS's design deliverables — see style.css's CIS component CSS block, appended 2026-10-28.
  private appendUserBubble(text: string) {
    const row = document.createElement('div');
    row.className = 'la-message is-user';
    row.innerHTML = `<div class="la-bubble"></div>`;
    row.querySelector('.la-bubble')!.textContent = text;
    this.chatLogEl.appendChild(row);
    // Always forced, not scrollDownIfPinned — sending a message is the customer's own action, so
    // following it to the bottom is always expected, never a "fight" against a manual scroll-up.
    this.scrollDown();
  }

  private appendBotBubble(html: string, hint?: string | null) {
    // No typing-indicator swap (removed 2026-10-29) — a two-step "empty bubble, wait, replace
    // with real bubble" render was the actual source of every bubble-flicker bug reported this
    // session (CSS cascade conflicts in the intermediate empty state kept resurfacing in subtly
    // different ways no matter how many times that CSS was fixed/deduplicated). The bubble's DOM
    // node is still never swapped — the typewriter effect below (2026-10-31) only ever grows text
    // already sitting inside the final, already-correct markup, so that bug class can't recur.
    const wasNearBottom = this.isNearBottom();
    const row = document.createElement('div');
    row.className = 'la-message is-new is-current';
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble">${html}${
      hint ? `<div class="lc-hint">${hint}</div>` : ''
    }</div>`;
    this.chatLogEl.appendChild(row);
    this.scrollDownIfPinned(wasNearBottom);
    // .is-new carries a `will-change` compositing hint (see style.css) so the arrival animation
    // doesn't force a repaint of .la-chat's large background artwork every frame — stripped once
    // the animation finishes so GPU layers don't pile up across a long conversation.
    row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
    const bubble = row.querySelector<HTMLElement>('.la-bubble');
    if (bubble) this.typeOutBubble(bubble, wasNearBottom);
  }

  /** Makes a bot bubble feel typed rather than dumped on screen instantly (2026-10-31 direct
   * instruction: "it should feel like the bot is replying... thoda sa smooth banao... premium
   * feel"). Only ever mutates existing TEXT NODES' own .data — the HTML structure (tags, the hint
   * div, etc.) is rendered complete from the very first frame, so this can never corrupt markup the
   * way an incremental innerHTML-rebuild approach could. Duration is capped regardless of message
   * length ("typing speed should be thoda fast, the customer should not wait") — a one-line reply
   * and a long paragraph both finish within the same short window, just at different per-character
   * speeds. */
  private typeOutBubble(bubble: HTMLElement, followScroll: boolean) {
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let full = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node as Text;
      textNodes.push(t);
      full += t.data;
    }
    const totalChars = full.length;
    if (totalChars === 0) return;
    const originals = textNodes.map((t) => t.data);
    textNodes.forEach((t) => (t.data = ''));

    const maxDurationMs = 420;
    const minPerCharMs = 9;
    const totalDuration = Math.min(maxDurationMs, totalChars * minPerCharMs);
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      const revealed = Math.min(totalChars, Math.round((elapsed / totalDuration) * totalChars));
      let remaining = revealed;
      for (const [i, node] of textNodes.entries()) {
        const len = Math.min(remaining, originals[i].length);
        if (node.data.length !== len) node.data = originals[i].slice(0, len);
        remaining -= len;
        if (remaining <= 0) break;
      }
      if (followScroll) this.scrollDown();
      if (revealed < totalChars) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private async appendLoadingThenBot(label: string, html: string, hint?: string | null) {
    const wasNearBottom = this.isNearBottom();
    const row = document.createElement('div');
    row.className = 'la-message';
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble lc-loading-row"><div class="lc-spinner"></div><span class="lc-loading-label"></span></div>`;
    row.querySelector<HTMLElement>('.lc-loading-label')!.textContent = label;
    this.chatLogEl.appendChild(row);
    this.scrollDownIfPinned(wasNearBottom);
    await sleep(900);
    row.remove();
    await this.appendBotBubble(html, hint);
  }

  private updateProgress(resp: ChatTurnResponse) {
    const pct = Math.round((resp.progress.stepNumber / Math.max(resp.progress.totalSteps, 1)) * 100);
    this.progressPctEl.textContent = `${pct}% complete`;

    // Map stepId / label to CIS phase names: GETTING STARTED, IDENTITY, LOAN DETAILS, ELIGIBILITY, COMPLETE
    const stepId = (resp.stepId || '').toLowerCase();
    const label = (resp.progress.label || '').toLowerCase();
    let phase = 'IDENTITY';
    if (!resp.progress.stepNumber || resp.progress.stepNumber <= 1 || label.includes('getting started')) {
      phase = 'GETTING STARTED';
    } else if (
      label.includes('identity') ||
      label.includes('credit') ||
      label.includes('about you') ||
      ['mobile', 'otp', 'pan', 'bureau', 'dedupe', 'name', 'dob', 'gender', 'email'].some((k) => stepId.includes(k))
    ) {
      phase = 'IDENTITY';
    } else if (resp.done || stepId.includes('result') || label.includes('eligibility') || label.includes('offers')) {
      phase = 'ELIGIBILITY';
    } else {
      phase = 'LOAN DETAILS';
    }
    this.progressStepEl.textContent = phase;

    if (this.segmentsEl) {
      this.segmentsEl.setAttribute('aria-valuenow', String(pct));
      const segments = this.segmentsEl.querySelectorAll('i');
      segments.forEach((seg, i) => {
        const fill = Math.max(0, Math.min(100, (pct - i * 20) * 5));
        seg.style.setProperty('--fill', `${fill}%`);
      });
    }
    if (this.progressFillEl) this.progressFillEl.style.width = `${pct}%`;
  }

  private clearComposer() {
    this.composerEl.classList.remove('has-otp');
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
        // Appended into the chat log itself, not the composer — matches CIS's real design, where
        // the results card reads as part of the bot's reply flowing in the conversation, not a
        // separate boxed section below it (2026-10-30 direct instruction; an earlier same-day fix
        // tried to fake this purely with CSS on the composer, which also silently broke scrolling
        // since the composer's own scroll/height cap had to be stripped to make it look blended —
        // moving the actual DOM node is the correct fix, not a CSS illusion on the wrong parent).
        this.resultContainerEl = document.createElement('div');
        this.chatLogEl.appendChild(this.resultContainerEl);
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
      // card itself is often taller than the visible chat body. BUT for lead-only products with no
      // eligibility figure at all (Loan Against Securities, Business Loan — just "Application
      // received" + the RM card), the card is short, so scrollIntoView({block:'start'}) scrolls the
      // real lead-created bot message bubble (appended just above this card a moment ago) OFF the
      // TOP of the viewport entirely — looked like the message never appeared, with a big empty gap
      // above a seemingly-orphaned RM card (reported 2026-10-30). Those two just scroll to the
      // bottom instead, same as every normal reply, so the message bubble stays in view.
      const resultProduct = (resp.result as { product?: string } | undefined)?.product;
      const isShortLeadOnlyResult = resultProduct === 'Loan Against Securities' || resultProduct === 'Business Loan';
      if (isFirstResultRender && !isShortLeadOnlyResult) {
        this.scrollToResultTop();
      } else {
        this.scrollDown();
      }
      return;
    }

    this.renderComposer(resp);
    // Smart, not forced — the bot bubble just above (if any) already scrolled appropriately; this
    // used to unconditionally re-force the bottom right after, undoing a deliberate scroll-up the
    // moment the next composer rendered (2026-10-31 fix — part of "scroll up kabhi kabhi nahi
    // horaha"). renderComposer only touches the separate composer region, not bodyEl's own
    // scrollHeight, so checking isNearBottom() here still reflects the chat log correctly.
    this.scrollDownIfPinned(this.isNearBottom());

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
            plCard.innerHTML = lenderThankYouHtml(lenderName, rmName);
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
            if (lenderList) lenderList.innerHTML = lenderThankYouHtml(lenderName, rmName);
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
    this.scrollDownIfPinned(this.isNearBottom());
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
      <div class="la-actions">
        <button class="la-primary" id="lc-pan-offer-yes">${this.panOfferNeedsMobile ? 'Yes, share details' : 'Yes, share PAN'}</button>
        <button class="la-secondary" id="lc-pan-offer-no">No thanks</button>
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
    const form = document.createElement('form');
    form.className = 'la-chat-input-form';
    form.onsubmit = (e) => {
      e.preventDefault();
      submit();
    };

    const wrap = document.createElement('div');
    wrap.className = 'la-input-row';

    const input = document.createElement('input');
    input.className = 'la-input';
    input.type = opts.type;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    if (opts.inputMode) input.inputMode = opts.inputMode as any;
    if (opts.uppercase) input.style.textTransform = 'uppercase';
    if (opts.max) input.max = opts.max;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    if (opts.uppercase) {
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase();
      });
    }

    const btn = document.createElement('button');
    btn.className = 'la-primary la-send';
    btn.type = 'submit';
    btn.setAttribute('aria-label', 'Send');
    btn.innerHTML = ICON.send;
    const submit = () => {
      if (!input.value.trim()) return;
      this.submitUserValue(stepId, input.value, input.value);
    };
    btn.onclick = (e) => {
      e.preventDefault();
      submit();
    };

    wrap.appendChild(input);
    wrap.appendChild(btn);
    form.appendChild(wrap);
    this.composerEl.appendChild(form);

    // Continuous 7s orbit driver ensuring the border beam rotates across all browsers
    let angle = 0;
    let lastTime = performance.now();
    const speed = 360 / 7000;
    const stepOrbit = (now: number) => {
      if (!wrap.isConnected) return;
      const delta = now - lastTime;
      lastTime = now;
      angle = (angle + delta * speed) % 360;
      wrap.style.setProperty('--la-orbit', `${angle.toFixed(1)}deg`);
      requestAnimationFrame(stepOrbit);
    };
    requestAnimationFrame(stepOrbit);

    input.focus();
  }

  /** Basic flow: every choice question is a fixed set of buttons, no typing or fuzzy matching —
   * clicking sends the option's exact text straight through. .la-options/.la-option classes are
   * copied verbatim from CIS's design deliverables — see style.css's CIS component CSS block,
   * appended 2026-10-28 (the `layout` row/column distinction no longer applies — CIS always stacks
   * options in a single column). */
  private renderChoiceComposer(stepId: string, options: string[], _layout: 'row' | 'column') {
    const wrap = document.createElement('div');
    wrap.className = 'la-options';
    for (const option of options) {
      const btn = document.createElement('button');
      btn.className = 'la-option';
      btn.type = 'button';
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
    wrap.className = 'la-actions';

    const eligibilityBtn = document.createElement('button');
    eligibilityBtn.className = 'la-primary';
    eligibilityBtn.textContent = 'Check my eligibility';
    eligibilityBtn.onclick = () => void this.restartWithIntent(CHECK_ELIGIBILITY);

    const statusBtn = document.createElement('button');
    statusBtn.className = 'la-secondary';
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
    this.resultCollapsed = false; // shows expanded on every fresh check, not just the first ever
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
      // Was hardcoded to stepId: 'intent' (2026-10-31 fix) — correct today only because 'intent'
      // happens to be the flow's first step, but a silent trap: if a brand-new blank session ever
      // lands on anything else first, this would submit "Check my eligibility"/"Check an existing
      // application" as the answer to the WRONG step, which is exactly the kind of mismatch that
      // could make an eligibility click appear to land in the status flow (or vice versa) with no
      // obvious cause. Using the step the server just actually told us we're on removes that risk
      // entirely instead of relying on an assumption staying true forever.
      const answered = await this.api.send({ sessionToken: this.sessionToken, stepId: start.stepId, value: intent });
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

  // .la-otp/.la-primary/.la-secondary/.la-link classes below are copied verbatim from CIS's
  // design deliverables — see style.css's CIS component CSS block, appended 2026-10-28.
  private renderOtpComposer(stepId: string, length: number) {
    this.composerEl.classList.add('has-otp');
    const wrap = document.createElement('div');
    wrap.className = 'la-otp-wrap';

    const boxes = document.createElement('div');
    boxes.className = 'la-otp';
    const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < length; i++) {
      const inp = document.createElement('input');
      inp.maxLength = 1;
      inp.inputMode = 'numeric';
      inp.autocomplete = i === 0 ? 'one-time-code' : 'off';
      inp.setAttribute('aria-label', `OTP digit ${i + 1}`);
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '');
        if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
        // Auto-verify once every digit is filled, matching CIS's real mobile file exactly
        // (apply-now-journey-2026-10-28.html's own otp() verifies on every input event the moment
        // the 6th digit lands, with no separate button at all — confirmed from its live source,
        // 2026-10-30 fix: "it doesn't even have the verify button otp automatically verifies on
        // mob"). Scoped to the mobile breakpoint only — desktop keeps the explicit Verify button,
        // which isn't what was reported broken.
        if (window.matchMedia('(max-width:768px)').matches && inputs.every((f) => f.value.length === 1)) {
          const code = inputs.map((f) => f.value).join('');
          this.submitUserValue(stepId, code, '••••••', true);
        }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus();
      });
      inp.addEventListener('paste', (e) => {
        const code = e.clipboardData?.getData('text').replace(/\D/g, '').slice(0, length);
        if (!code) return;
        e.preventDefault();
        code.split('').forEach((v, j) => {
          if (inputs[j]) inputs[j].value = v;
        });
        const nextIdx = Math.min(length - 1, code.length - 1);
        inputs[nextIdx]?.focus();
      });
      inputs.push(inp);
      boxes.appendChild(inp);
    }
    wrap.appendChild(boxes);

    const actions = document.createElement('div');
    actions.className = 'la-otp-actions';

    const RESEND_COOLDOWN_SECONDS = 30;
    const resend = document.createElement('button');
    resend.className = 'la-secondary la-otp-resend';
    resend.type = 'button';
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
    actions.appendChild(resend);
    startCooldown(RESEND_COOLDOWN_SECONDS);

    const right = document.createElement('div');
    right.className = 'la-otp-right';

    // Lets a customer back out of a typo'd mobile number before ever verifying it — only makes
    // sense on the very first OTP (otpDedupe verifies the mobile number itself); every other OTP
    // step this same composer renders for (bureau consent, PAN/email duplicate-verify) is either
    // re-confirming an already-verified number or one the customer doesn't own to begin with, so
    // "edit it" would be meaningless there. There's no partial "go back one step" in this engine
    // (it only ever walks forward), so this is a full restart under the hood — safe with no
    // confirmation this early, since at most an intent choice is lost (2026-10-17 instruction).
    if (stepId === 'otpDedupe') {
      const editNumber = document.createElement('button');
      editNumber.className = 'la-tertiary la-otp-edit';
      editNumber.type = 'button';
      editNumber.textContent = 'Wrong number? Edit it';
      editNumber.onclick = () => this.restart();
      right.appendChild(editNumber);
    }

    const btn = document.createElement('button');
    btn.className = 'la-primary la-otp-verify';
    btn.type = 'button';
    btn.textContent = 'Verify OTP';
    btn.onclick = () => {
      const code = inputs.map((i) => i.value).join('');
      // Deferred: a wrong attempt shouldn't leave a "••••••" bubble sitting in the chat log
      // forever — only worth showing once we know it actually worked.
      this.submitUserValue(stepId, code, '••••••', true);
    };
    right.appendChild(btn);

    actions.appendChild(right);
    wrap.appendChild(actions);

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
    row.className = 'la-message';
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble lc-loading-row"><div class="lc-spinner"></div><span class="lc-loading-label"></span></div>`;
    row.querySelector<HTMLElement>('.lc-loading-label')!.textContent = label;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
    return row;
  }

  /** Shown the instant the eligibility computation starts (this is the slowest step — a real
   * lead-creation + lender-offers round trip). Reverted 2026-10-30 (second same-day instruction) —
   * the bouncing-dots version this briefly became didn't preview what's loading; now shows 3
   * skeleton rows shaped like the real `.la-lender` cards about to appear (icon/name/amount
   * placeholders, CIS's own `.la-skeleton`/`la-pulse` primitives), still inside a normal chat
   * bubble in the conversation flow rather than a separate panel. */
  private showSkeletonCard(): HTMLElement {
    this.clearComposer();
    const row = document.createElement('div');
    row.className = 'la-message';
    const skeletonRow = () => `
      <div class="lc-skel-row">
        <div class="la-skeleton lc-skel-icon"></div>
        <div class="lc-skel-lines">
          <div class="la-skeleton" style="width:55%"></div>
          <div class="la-skeleton" style="width:35%;height:10px"></div>
        </div>
        <div class="la-skeleton lc-skel-amount"></div>
      </div>`;
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble"><div class="lc-skel-lenders">${skeletonRow()}${skeletonRow()}${skeletonRow()}</div></div>`;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
    return row;
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
    row.className = 'la-message';
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble"></div>`;
    row.querySelector('.la-bubble')!.textContent = message;
    this.chatLogEl.appendChild(row);
    const btn = document.createElement('button');
    btn.className = 'lc-ghost-btn';
    btn.textContent = 'Retry';
    btn.onclick = () => this.start();
    this.composerEl.appendChild(btn);
  }

  /** Small themed replacement for window.confirm() — appended to the panel itself (not document
   * body) so it's scoped inside the shadow root and sits above everything via the panel's own
   * stacking context. Removed on either button click or Escape; nothing else on the page can
   * interact with it while it's open (a plain opaque scrim, no focus trap needed for one message +
   * two buttons). */
  private showConfirmDialog(title: string, body: string, onConfirm: () => void) {
    const existing = this.panelEl.querySelector('.la-confirm-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'la-confirm-overlay';
    overlay.innerHTML = `
      <div class="la-confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>${title}</h3>
        <p>${body}</p>
        <div class="la-confirm-actions">
          <button type="button" class="la-secondary" data-confirm-cancel>Cancel</button>
          <button type="button" class="la-primary" data-confirm-ok>Yes, start over</button>
        </div>
      </div>
    `;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-confirm-cancel]')!.addEventListener('click', close);
    overlay.querySelector('[data-confirm-ok]')!.addEventListener('click', () => {
      close();
      onConfirm();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    this.panelEl.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-confirm-ok]')!.focus();
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
    this.resultCollapsed = false; // shows expanded on every fresh check, not just the first ever
    this.panOfferOffered = false;
    this.panOfferNeedsMobile = false;
    this.panOfferResolved = null;
    this.statusActionsShown = false;
    this.chatLogEl.innerHTML = '';
    if (this.progressStepEl) this.progressStepEl.textContent = 'GETTING STARTED';
    if (this.progressPctEl) this.progressPctEl.textContent = '0% complete';
    if (this.segmentsEl) {
      this.segmentsEl.setAttribute('aria-valuenow', '0');
      this.segmentsEl.querySelectorAll('i').forEach((s) => s.style.setProperty('--fill', '0%'));
    }
    void this.start();
  }

  /** CIS's own collapse mechanic for the results screen (captured verbatim from
   * personal-suite-updated.html, 2026-10-28): a single toggle link flips a `data-collapsed`
   * attribute on the `.la-results` section and the `hidden` attribute on its detail children (the
   * estimate block, the "Eligibility by lender" label, every lender accordion, and the
   * disclaimer) — not our old separate pill/expanded-block pair. The RM card and restart button
   * stay visible either way. Also restores whichever state was active before a profile-panel edit
   * re-rendered the card's contents. */
  private wireResultMinimize() {
    const section = this.resultContainerEl.querySelector<HTMLElement>('#lc-result-expanded.la-results');
    const toggleBtn = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-btn-minimize');
    if (!section || !toggleBtn) {
      // Not-eligible/no-offer result cards still use the older pill pattern (no CIS equivalent was
      // captured for that state) — keep that working as before.
      this.wireResultMinimizeLegacyPill();
      return;
    }

    const detailEls = () => [
      ...Array.from(section.querySelectorAll<HTMLElement>(':scope > .la-estimate')),
      ...Array.from(section.querySelectorAll<HTMLElement>(':scope > #lc-eligibility-by-lender-label')),
      ...Array.from(section.querySelectorAll<HTMLElement>(':scope > #lc-lender-list > .la-lender')),
      ...Array.from(section.querySelectorAll<HTMLElement>(':scope > #lc-disclaimer')),
    ];

    const apply = (collapsed: boolean) => {
      section.toggleAttribute('data-collapsed', collapsed);
      detailEls().forEach((el) => el.toggleAttribute('hidden', collapsed));
      toggleBtn.textContent = collapsed ? 'Show eligibility' : 'Minimize';
      toggleBtn.setAttribute('aria-label', collapsed ? 'Show eligibility' : 'Minimize');
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    };

    apply(this.resultCollapsed);
    toggleBtn.onclick = () => {
      this.resultCollapsed = !this.resultCollapsed;
      apply(this.resultCollapsed);
    };
  }

  /** The not-eligible/no-offer result card (see resultCard.ts) still renders the older
   * pill/expanded-block pair — no CIS design was captured for that state. */
  private wireResultMinimizeLegacyPill() {
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
