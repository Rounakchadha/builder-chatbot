import { CHECK_ELIGIBILITY, CHECK_EXISTING_APPLICATION, type ChatTurnResponse, type InputSpec } from '@builder-chatbot/shared';
import { ChatApi, SessionExpiredError, describeApiError } from './api';
import { cisLogo } from './cisLogo';
import { ErrorReporter } from './errorReporter';
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
/** Shared by showSkeletonCard (first eligibility computation) and showResultRecalculating (a
 * profile-panel edit recomputing it) — same placeholder shape either way: 3 rows styled like the
 * real `.la-lender` cards about to replace them (icon/name/amount), using CIS's own
 * `.la-skeleton`/`la-pulse` primitives. */
function skeletonLenderRowsHtml(): string {
  const skeletonRow = () => `
      <div class="lc-skel-row">
        <div class="la-skeleton lc-skel-icon"></div>
        <div class="lc-skel-lines">
          <div class="la-skeleton" style="width:55%"></div>
          <div class="la-skeleton" style="width:35%;height:10px"></div>
        </div>
        <div class="la-skeleton lc-skel-amount"></div>
      </div>`;
  return `<div class="lc-skel-lenders">${skeletonRow()}${skeletonRow()}${skeletonRow()}</div>`;
}

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
  /** The currently-live set of choice "quick reply" pills in the chat log (see
   * renderChoiceComposer) — tracked so an earlier, unanswered question's buttons get disabled the
   * moment a newer one renders, instead of staying clickable and silently submitting a stale
   * answer against whatever step the conversation has since moved past. */
  private activeChoiceEl: HTMLElement | null = null;
  /** Set by restart()'s keepChatLog path, removed the moment a real response (success or error)
   * actually arrives — see restart()'s own comment for why this exists. */
  private productSwitchLoadingEl: HTMLElement | null = null;
  /** Which product the chat log currently on screen belongs to (from the last response's own
   * `product` field) — compared against each new response in renderTurn to detect an actual
   * product switch (not just "a different question"). Undefined until the first response with a
   * known product ever arrives. */
  private currentProduct: string | undefined;
  /** Per-SESSION (keyed by sessionToken, not a single scalar) record of the last stepId actually
   * rendered for that session — lets renderTurn detect "the server just told me to show the exact
   * same question/result I already have on screen for THIS product's session" and skip
   * re-appending it, regardless of WHY that happened (restoring a per-product stash, a second
   * concurrent response for the same switch landing after the first already rendered it, anything
   * else). Bug fixed 2026-11-13: the earlier fix only caught the stash-restore case, and only once
   * per product (a stash entry is consumed/removed the moment it's restored) — a second or third
   * visit back to the same product, or closely-timed clicks, still duplicated the question. Must be
   * keyed per sessionToken, not a single last-seen value — a single scalar gets overwritten the
   * moment you switch to a DIFFERENT product's session in between, so it would no longer match when
   * you come back to the first one even though that's exactly the repeat-render case this exists to
   * catch. Each product keeps its own sessionToken for the life of its session, so this map holds
   * one entry per product actually visited; never cleared out (a handful of products, not a memory
   * concern for a single widget instance's lifetime). */
  private lastRenderedStepBySession: Map<string, string> = new Map();
  /** Catches a duplicate that lastRenderedStepBySession above can't: a BRAND NEW sessionToken
   * showing the exact same step+message as the product's own immediately-previous turn (2026-11-14
   * — reported the same first question piling up 2-3x on reopening a product). Before mobile is
   * known there's nothing to resume by (profile.service.ts is mobile-keyed), so every restart of an
   * anonymous, not-yet-identified visit necessarily mints a genuinely new session/token — but if
   * nothing about the product actually changed (switchProductLog didn't restore/stash anything,
   * i.e. we're still looking at that same product's live log) and the content is identical to what's
   * already the last thing shown there, it's the same repeat-render case lastRenderedStepBySession
   * exists to catch, just reached via a different session each time instead of the same one. */
  private lastRenderedSignatureByProduct: Map<string, string> = new Map();
  /** Set by restart()'s plain (non-keepChatLog) path — the explicit "Start over" button/confirm
   * dialog — and read/cleared by the very next start() call. Tells the server this is a genuine,
   * deliberate restart (see shared's ChatMessageRequest.forceNew), not just the first open() of a
   * fresh page load, so it knows to ignore/forget any per-product resume pointer instead of quietly
   * resuming the same session (2026-11-13 fix). */
  private forceNewOnNextStart = false;
  /** Each product's own chat history, kept separate (2026-11-12 instruction: switching products
   * used to show one merged scrollback across all of them, confusing — Home Loan's messages/
   * buttons mixed in with Personal Loan's). Stores the actual DOM nodes (not serialized HTML),
   * since choice buttons' click handlers are plain JS closures that innerHTML round-tripping would
   * silently lose. */
  private readonly chatLogsByProduct = new Map<string, ChildNode[]>();
  /** See scrollToResultTop's and typeOutBubble's own doc comments — lets a definitive "scroll to
   * here" moment (the result card arriving) cancel a bot-reply typing animation's own per-frame
   * scroll-following still in flight, instead of the two fighting over where the view ends up. */
  private suppressAutoScrollFollow = false;
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
  /** Set only by a launchToken passed into open() — a one-time, server-to-server-issued value (see
   * launchToken.service.ts), never persisted to localStorage like STORAGE_KEY/IDENTITY_STORAGE_KEY
   * above, since it's single-use and tied to this one open() call, not something to resume later. */
  private launchToken: string | null = null;
  /** The last launchToken open() actually acted on (restarted or did the very first start() for) —
   * see open()'s own doc comment (2026-11-14): a REPEAT of this exact value means nothing about the
   * customer's identity/product has changed since, so there's nothing to restart for. */
  private lastAppliedLaunchToken: string | null = null;
  private errorReporter: ErrorReporter;

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
    this.errorReporter = new ErrorReporter(opts.apiBaseUrl, () => this.sessionToken);
    this.errorReporter.start();
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

    // The two conversation-panel background images (style.css) used to be inlined as base64 right
    // here — 4.49MB of this bundle, by far its biggest chunk (security-review finding, 2026-11-02).
    // Now they're plain static files served from our own API, referenced via this placeholder since
    // a relative url() in CSS injected as inline text would resolve against whatever page embeds the
    // widget, not our server.
    const styleEl = document.createElement('style');
    styleEl.textContent = widgetStyles.split('__LC_API_BASE__').join(this.opts.apiBaseUrl);
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
          <div class="la-chat" role="log" aria-live="polite" aria-relevant="additions" aria-label="Loan conversation"><div class="la-chat-spacer" aria-hidden="true"></div></div>
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
            <!-- Wrapped together (2026-10-31 fix: "ur details and cross button should stay static
                 if i swipe down my details till the bottom") so the heading/subtext/close button
                 pin to the top of the sheet's own scroll area via position:sticky (mobile only)
                 while just the fields list underneath scrolls — see .la-sheet-sticky-top's own CSS
                 doc comment. The close button was ORIGINALLY left as a sibling, on the assumption
                 that position:absolute relative to .la-sidebar would already keep it static during
                 scroll regardless — that assumption was wrong: an absolutely-positioned element's
                 containing block being a SCROLLING ancestor doesn't exempt it from scrolling WITH
                 that ancestor's content (only position:sticky/fixed do that), so it was moving up
                 with the page too (2026-10-31 follow-up report). Moved inside the sticky wrapper,
                 which is itself position:relative so the button's absolute offsets now resolve
                 against the sticky wrapper's own (now-pinned) box instead. -->
            <div class="la-sheet-sticky-top">
              <div class="la-sheet-handle" aria-hidden="true"></div>
              <button type="button" class="la-details-close" aria-label="Close your details">${ICON.close}</button>
              <h2 class="la-details-heading">Your details</h2>
              <p class="la-details-subtext">Saved automatically as you go</p>
            </div>
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
    // Drag-handle swipe-to-close. Previously matched CIS's own gesture literally — "pointer went
    // down, then came back up more than 50px lower" — but that's just a binary open/closed check
    // with NO visual feedback while dragging; the sheet only ever snapped, never actually followed
    // the finger (2026-10-31 report: "its just open and closing not smoothly going down with
    // touch"). Now the sheet's own translateY tracks the pointer in real time while dragging
    // (transition disabled so it isn't laggy), then animates the rest of the way closed or snaps
    // back open on release depending on how far it was dragged.
    const handleEl = panel.querySelector<HTMLElement>('.la-sheet-handle')!;
    const DRAG_CLOSE_THRESHOLD_PX = 90;
    let dragStartY: number | null = null;
    const closeSheetWithDragAnimation = () => {
      sidebarEl.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
      sidebarEl.style.transform = 'translateY(100%)';
      sidebarEl.addEventListener(
        'transitionend',
        () => {
          sidebarEl.style.transition = '';
          sidebarEl.style.transform = '';
          setSidebarOpen(false);
        },
        { once: true },
      );
    };
    const snapSheetBackOpen = () => {
      sidebarEl.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      sidebarEl.style.transform = 'translateY(0)';
      sidebarEl.addEventListener(
        'transitionend',
        () => {
          sidebarEl.style.transition = '';
          sidebarEl.style.transform = '';
        },
        { once: true },
      );
    };
    handleEl.addEventListener('pointerdown', (e) => {
      dragStartY = e.clientY;
      sidebarEl.style.transition = 'none'; // follow the finger with no lag while dragging
      handleEl.setPointerCapture(e.pointerId);
    });
    handleEl.addEventListener('pointermove', (e) => {
      if (dragStartY === null) return;
      const delta = Math.max(0, e.clientY - dragStartY); // never drag "up" past fully open
      sidebarEl.style.transform = `translateY(${delta}px)`;
    });
    handleEl.addEventListener('pointerup', (e) => {
      if (dragStartY === null) return;
      const delta = e.clientY - dragStartY;
      dragStartY = null;
      if (delta > DRAG_CLOSE_THRESHOLD_PX) closeSheetWithDragAnimation();
      else snapSheetBackOpen();
    });
    handleEl.addEventListener('pointercancel', () => {
      if (dragStartY === null) return;
      dragStartY = null;
      snapSheetBackOpen();
    });

    this.panelEl = panel;
    this.launcherEl = launcher;
    this.profilePanel = new ProfilePanel(
      panel.querySelector('.la-sidebar-fields')!,
      this.api,
      () => this.sessionToken,
      (result, messages) => void this.applyUpdatedResult(result, messages),
      () => this.showResultRecalculating(),
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
   * trigger this widget from its own existing chat-entry-point UI instead of this widget's launcher.
   * `launchToken` (2026-11-02, SDK — see launchToken.service.ts): a partner's own backend encrypts
   * product/mobile/email with a shared secret and passes the result straight here, pre-filling the
   * widget so the customer isn't asked for what the partner's app already knows. Only read if this
   * is the very first start() this instance makes (no stored sessionToken yet); ignored on every
   * later open() call in the same page session, same as identityToken/STORAGE_KEY never resetting
   * mid-session. */
  open(launchToken?: string): void {
    // Bug fixed 2026-11-13: this used to only restart when `this.started` was already true (i.e.
    // NOT the first open() this page load) and the token differed from an in-memory "last token"
    // that resets on every reload. That meant the very FIRST click after a reload always fell
    // through to silently resuming whatever sessionToken happened to be sitting in localStorage —
    // which could be for a COMPLETELY different product (reported: reload while on Personal Loan,
    // click Home Loan, it stays stuck on Personal Loan until clicked a second time). The same
    // in-memory comparison also misfired in other ways (reported: switching products sometimes
    // got stuck on the wrong one, sometimes only self-corrected after several seconds).
    //
    // Fix: an explicit launchToken is now ALWAYS authoritative, every single time, full stop — we
    // no longer try to guess client-side whether it's "really" a different product. The server's
    // own per-product session lookup (profile.service.ts/chat.ts) reliably resolves resume-vs-fresh
    // from the token's own decrypted mobile+product, which is far more trustworthy than anything
    // this widget can infer about its own in-memory state across reloads/re-clicks.
    //
    // Bug fixed 2026-11-14 (reported: reopening the same product piled up the same first question
    // 2-3 times, with a "Switching…" bubble on top) — "always authoritative" above was about a
    // DIFFERENT token ever being ignored, not about the host calling open() more than once with the
    // EXACT SAME token for whatever's already on screen (a re-render, a second click handler, etc).
    // Before mobile is known, every restart necessarily starts a genuinely new server-side session
    // (there's nothing to resume by yet — see profile.service.ts, keyed on mobile), and this product
    // hasn't actually changed, so switchProductLog's own "no-op unless the product changed" check
    // never clears the log either — the two gaps together let every repeat pile up a fresh copy of
    // the same first question. A literal repeat of the last token actually applied changes nothing
    // about who the customer is, so there's nothing to restart for.
    if (launchToken) {
      const isRepeatOfLastApplied = this.started && launchToken === this.lastAppliedLaunchToken;
      this.launchToken = launchToken;
      this.lastAppliedLaunchToken = launchToken;
      if (isRepeatOfLastApplied) {
        // Already showing exactly this — just bring the panel up, nothing to restart.
      } else if (this.started) {
        this.restart({ keepChatLog: true });
      } else {
        // First open() this page load — still must never blindly resume a stale sessionToken left
        // in localStorage from a previous page load/product before this launchToken is honored.
        safeRemoveItem(STORAGE_KEY);
        this.sessionToken = null;
        this.started = true;
        void this.start();
      }
    }
    this.toggle(true);
  }

  /** Closes the panel from outside — same idea as open() in reverse, for a host page that wants its
   * own UI (e.g. a custom back/close button elsewhere on the page) to dismiss the widget too, not
   * just the widget's own built-in × button (2026-11-04, requested alongside the SDK integration). */
  close(): void {
    this.toggle(false);
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
    this.errorReporter.stop();
    this.hostEl?.remove();
    this.hostEl = null;
  }

  private async start(): Promise<void> {
    const gen = ++this.requestGen;
    const forceNew = this.forceNewOnNextStart;
    this.forceNewOnNextStart = false;
    try {
      const resp = this.sessionToken
        ? await this.api.send({ sessionToken: this.sessionToken })
        : await this.api.send({ identityToken: safeGetItem(IDENTITY_STORAGE_KEY) ?? undefined, launchToken: this.launchToken ?? undefined, forceNew: forceNew || undefined });
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
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'), err);
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
    // Stops any bot-reply typing animation still mid-flight (e.g. the "you're eligible" message
    // shown right before this) from re-dragging the view back to the bottom on its own later frames
    // — see typeOutBubble's own doc comment. THIS, not scrollIntoView itself, was almost certainly
    // the real cause of the "drags the screen to the end... have to scroll up to see the main
    // cards" report: scrollDown() (from the bot bubble right before the result) and the typing
    // animation's own per-frame scrollDown() calls were both still firing AFTER this ran, winning
    // the race and re-forcing the bottom. A geometry-based scrollTop calculation (tried 2026-10-31
    // as the fix, before the real cause above was found) turned out to be its own dead end — .la-
    // chat is `justify-content:flex-end`, which several engines handle inconsistently for manual
    // scrollTop math on an overflowing flex container; scrollIntoView is the spec-correct, native
    // way to do this and isn't affected by that quirk, so it's back now that the actual race is
    // fixed instead of the symptom it was wrongly blamed for.
    this.suppressAutoScrollFollow = true;
    requestAnimationFrame(() => {
      this.resultContainerEl.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  }

  /** Wipes the chat log back to empty (Start over, session-expired recovery, etc.) — always leaves
   * the .la-chat-spacer placeholder as the first child (see its own CSS doc comment: it's what keeps
   * a short conversation bottom-aligned WITHOUT `justify-content:flex-end` on the scroll container
   * itself, which is what actually caused "once it goes down it doesn't go up" — confirmed 2026-10-31
   * to affect other browsers/devices even though it never reproduced on Mac Safari). Call this
   * instead of setting chatLogEl.innerHTML = '' directly, or a fresh conversation loses the spacer
   * and the flex-end bug it exists to avoid would effectively come right back. */
  private resetChatLog() {
    this.chatLogEl.innerHTML = '<div class="la-chat-spacer" aria-hidden="true"></div>';
  }

  /** Keeps each product's chat history visually separate (2026-11-12 instruction) — called at the
   * top of every renderTurn with that turn's own `product`. A no-op unless the product genuinely
   * changed since the last turn (covers both a real product switch AND this widget's very first
   * response ever, where there's nothing yet to stash). Moves actual DOM nodes, not serialized
   * HTML — choice buttons' click handlers are plain JS closures an innerHTML round-trip would
   * silently lose. The `.la-chat-spacer` first child (see resetChatLog's own comment) is never
   * moved; it stays put in the live log regardless of whose history is currently shown. */
  /** Returns true when a previously-stashed log was just restored — see renderTurn's own use of
   * this: the restored content's LAST element is always the exact question/message the customer
   * was already looking at when they left, so the caller must not also append this turn's
   * botMessage/composer on top of it (that was the duplicated-question bug reported 2026-11-13 —
   * "What's your gender?" piling up, once per switch-away-and-back). */
  private switchProductLog(newProduct: string | undefined): boolean {
    if (!newProduct || newProduct === this.currentProduct) {
      if (newProduct) this.currentProduct = newProduct;
      return false;
    }
    if (this.currentProduct) {
      const toStash = Array.from(this.chatLogEl.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('la-chat-spacer')));
      toStash.forEach((n) => n.remove());
      this.chatLogsByProduct.set(this.currentProduct, toStash);
    }
    const restored = this.chatLogsByProduct.get(newProduct);
    if (restored) {
      restored.forEach((n) => this.chatLogEl.appendChild(n));
      this.chatLogsByProduct.delete(newProduct); // re-stashed under this key again next time we leave it
    }
    this.currentProduct = newProduct;
    return Boolean(restored);
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
    const wasNearBottom = this.isNearBottom();
    const row = document.createElement('div');
    row.className = 'la-message is-new is-current';

    // Parse html in a detached element to extract the text structure and tokens cleanly
    const template = document.createElement('div');
    template.innerHTML = html;

    // Create the message row with an empty bubble — NEVER inject the full text into the DOM beforehand!
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble"><span class="la-bubble-content"></span>${
      hint ? `<div class="lc-hint" style="opacity:0;transition:opacity .35s ease">${hint}</div>` : ''
    }</div>`;

    row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
    const bubble = row.querySelector<HTMLElement>('.la-bubble')!;
    const contentEl = row.querySelector<HTMLElement>('.la-bubble-content')!;

    // Move the parsed child nodes from template into contentEl
    while (template.firstChild) {
      contentEl.appendChild(template.firstChild);
    }

    // Now all text nodes are inside contentEl. Extract their original data and wipe them EMPTY.
    const isReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    const originals: string[] = [];
    let totalChars = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node as Text;
      textNodes.push(t);
      originals.push(t.data);
      totalChars += t.data.length;
      if (!isReduced) {
        t.data = ''; // COMPLETELY BLANK BEFORE EVER BEING ATTACHED TO THE VISIBLE DOM!
      }
    }

    this.suppressAutoScrollFollow = false;
    this.chatLogEl.appendChild(row);
    this.scrollDownIfPinned(wasNearBottom);

    const hintEl = bubble.querySelector<HTMLElement>('.lc-hint');
    if (totalChars === 0 || isReduced) {
      if (hintEl) hintEl.style.opacity = '1';
      return;
    }

    // Fast, smooth ChatGPT-style streaming cursor
    const cursor = document.createElement('span');
    cursor.className = 'lc-typing-cursor';
    if (hintEl) bubble.insertBefore(cursor, hintEl);
    else bubble.appendChild(cursor);

    // Fast, smooth continuous streaming: ~60-75 chars/sec (~14ms per character),
    // capped between 350ms and 1800ms so both short and long messages finish promptly.
    const totalDuration = Math.min(1800, Math.max(350, totalChars * 14));
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const isLastFrame = elapsed >= totalDuration;
      const progress = isLastFrame ? 1 : elapsed / totalDuration;
      const revealed = isLastFrame ? totalChars : Math.min(totalChars, Math.round(progress * totalChars));

      let remaining = revealed;
      for (const [i, node] of textNodes.entries()) {
        const len = Math.min(remaining, originals[i].length);
        if (node.data.length !== len) node.data = originals[i].slice(0, len);
        remaining -= len;
        if (remaining <= 0) {
          if (node.data.length > len) node.data = originals[i].slice(0, len);
        }
      }

      if (wasNearBottom && !this.suppressAutoScrollFollow && this.isNearBottom(140)) {
        this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
      }

      if (isLastFrame) {
        cursor.remove();
        if (hintEl) hintEl.style.opacity = '1';
      } else {
        requestAnimationFrame(step);
      }
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
    this.productSwitchLoadingEl?.remove();
    this.productSwitchLoadingEl = null;
    const stashRestored = this.switchProductLog(resp.product);
    this.updateProgress(resp);

    // Present once mobile+OTP is freshly verified — stored so a future brand-new session (a
    // normal restart, or just reopening the widget) can skip asking for both again, as long as
    // it's still within the remembered window. Safe to re-store the same value repeatedly.
    if (resp.identityToken) safeSetItem(IDENTITY_STORAGE_KEY, resp.identityToken);

    // "The server just told me to show the exact same question/result already on screen for THIS
    // product's session" — see lastRenderedStepBySession's own doc comment for why this check (not
    // whether a stash happened to be restored) is what actually prevents duplication, no matter how
    // many times someone switches back and forth. Only a genuinely mid-flight "none"-type step (an
    // apiFetch/message still auto-continuing toward something not shown yet) needs to fall through
    // to the normal path — a repeat of a FINISHED result is also caught here even though it's
    // "none"-type too.
    const productSignatureKey = resp.product ? `product:${resp.product}` : undefined;
    const thisSignature = `${resp.stepId}::${resp.botMessage ?? ''}`;
    const isDuplicateFreshSession =
      !resp.errorText &&
      !stashRestored &&
      productSignatureKey !== undefined &&
      this.lastRenderedSignatureByProduct.get(productSignatureKey) === thisSignature;
    const isRepeat =
      (!resp.errorText && this.lastRenderedStepBySession.get(resp.sessionToken) === resp.stepId) || isDuplicateFreshSession;
    const isRepeatResult = isRepeat && resp.done && Boolean(resp.result);
    if (isRepeat && (resp.input.type !== 'none' || isRepeatResult)) {
      if (resp.input.type === 'choice') {
        const lastChoiceWrap = Array.from(this.chatLogEl.querySelectorAll<HTMLElement>('.la-chat-options')).pop();
        this.activeChoiceEl = lastChoiceWrap ?? null;
      } else if (isRepeatResult) {
        const restoredResultEl = Array.from(this.chatLogEl.querySelectorAll<HTMLDivElement>('.lc-result-wrapper')).pop();
        if (restoredResultEl) this.resultContainerEl = restoredResultEl;
        this.resultCardShown = true;
        this.panOfferOffered = resp.panOffer ?? false;
        this.panOfferNeedsMobile = resp.panOfferNeedsMobile ?? false;
        if (resp.stepId === 'result' && resp.statusCheck) this.statusActionsShown = true;
      } else {
        // Every other interactive type's actual input lives in the separate composerEl, never
        // part of any stash (cleared on every restart/switch) — rebuild it so there's something to
        // answer with. Never touches chatLogEl for these types, so it can't duplicate anything.
        this.renderComposer(resp);
      }
      void this.profilePanel.refresh();
      this.scrollDown();
      return;
    }
    this.lastRenderedStepBySession.set(resp.sessionToken, resp.stepId);
    if (productSignatureKey !== undefined) this.lastRenderedSignatureByProduct.set(productSignatureKey, thisSignature);

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

    // Its own bubble, never merged into botMessage's (2026-11-13 instruction) — appended first so
    // it reads as "here's what we know" followed by a separate "now, the actual question" bubble,
    // not one combined wall of text.
    if (resp.recapMessage) {
      await this.appendBotBubble(resp.recapMessage);
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
        // Identifying marker (2026-11-13) — lets a per-product stash restore (see
        // switchProductLog/renderTurn) relocate this exact node later; a plain unmarked div can't
        // be found again by any selector.
        this.resultContainerEl.className = 'lc-result-wrapper';
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
    this.resultContainerEl.innerHTML = renderResultCard(result as any, this.opts.apiBaseUrl);
    const restartBtn = this.resultContainerEl.querySelector<HTMLButtonElement>('#lc-btn-restart');
    if (restartBtn) restartBtn.onclick = () => this.restart();
    this.wireResultMinimize();
    this.wireLenderToggles();
    this.wireLenderAccordionScroll();
    this.wireGoldSubmitCard();
    this.wireSelectOfferButtons();
    this.renderPanOffer();
  }

  /** The lender rows (<details class="la-lender">, see resultCard.ts) expand in place natively —
   * nothing stops the newly-revealed detail from landing partly or fully below the visible chat
   * area, especially for a row near the bottom of the list (2026-10-31 report: "when u click the
   * lender button it should come into frame"). Brings whichever one was just opened fully into view
   * once its content has actually expanded (the native 'toggle' event fires right as `open` flips,
   * so wait a frame for layout to catch up first). Only scrolls on OPEN, not collapse — collapsing
   * shouldn't yank the view anywhere. */
  private wireLenderAccordionScroll() {
    this.resultContainerEl.querySelectorAll<HTMLDetailsElement>('.la-lender').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        requestAnimationFrame(() => {
          details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      });
    });
  }

  /** General fix for a recurring class of bug (2026-10-31: "when im selecting the loan offer and
   * the thank u msg is coming the screen is going somewhere randomly... have to scroll down to it
   * why is this happening again and again"): any click handler below that rewrites part of the
   * result card — an offer selected, Gold Loan submitted, either one failing — shrinks or shifts
   * the surrounding content, but the browser never adjusts the customer's current scroll position
   * to match. If they were scrolled to where the button they just clicked used to be, that spot may
   * now be blank space once the content above/around it collapses. Call this with whatever element
   * just appeared/changed, right after every such mutation, not just the ones already reported —
   * the whole class of handler gets this, not one at a time as each one gets noticed. */
  private scrollChangedContentIntoView(el: HTMLElement) {
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
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
          if (slot) {
            slot.innerHTML = `<div class="lc-gold-submit-confirmed">${describeApiError(err, "Couldn't select this offer right now — please try again shortly.")}</div>`;
            this.scrollChangedContentIntoView(slot);
          }
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
            this.scrollChangedContentIntoView(plCard);
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
            if (lenderList) {
              lenderList.innerHTML = lenderThankYouHtml(lenderName, this.opts.apiBaseUrl, rmName);
              this.scrollChangedContentIntoView(lenderList);
            }
          }
        } else {
          slot.innerHTML = `<div class="lc-gold-submit-confirmed">Couldn't select this offer right now — please try again shortly.</div>`;
          this.scrollChangedContentIntoView(slot);
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
        if (slot) {
          slot.innerHTML = `<div class="lc-gold-submit-confirmed">${describeApiError(err, "Couldn't submit this application right now — please try again shortly.")}</div>`;
          this.scrollChangedContentIntoView(slot);
        }
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
      this.scrollChangedContentIntoView(slot);
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
    // Bug fixed 2026-11-11 (reported: edit messages landing BELOW the recalculated cards instead
    // of above them): resultContainerEl is created once, on the very first result render, and
    // simply has its innerHTML replaced on every later recompute — it never moves in the DOM, so
    // it always stayed wherever it first landed in chatLogEl, ABOVE every bot bubble appended after
    // it (the two "Got it — ..." / "Here's your updated eligibility" messages above included).
    // appendChild on a node already in the document MOVES it rather than duplicating it — this
    // puts the card back at the bottom, below the messages just appended above, matching the
    // intended order: message(s) on top while recalculating, fresh cards below once ready.
    this.chatLogEl.appendChild(this.resultContainerEl);
    this.renderResultInto(result);
    this.scrollToResultTop();
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
  /** Renders choice options as quick-reply pills INSIDE the chat log, right under the bot's own
   * question bubble — not in the separate composer panel below (2026-10-31 direct instruction:
   * "they are outside the chatbot... move these buttons inside the chatbot like the bot itself is
   * giving these options", plus making them visually pill-shaped and more compact). An earlier
   * still-unanswered question's pills (if the customer never clicked one before a new question
   * somehow rendered) are disabled rather than removed, so the chat history stays intact but can't
   * submit a stale answer against a step the conversation has already moved past. */
  private renderChoiceComposer(stepId: string, options: string[], _layout: 'row' | 'column') {
    // An earlier, still-unanswered question's pills (if a newer question somehow rendered before
    // the customer picked one) are removed outright, not just disabled — a grayed-out dead button
    // sitting in the chat log read as broken UI, not history (2026-10-31: "what is this man??").
    // The question text itself (in its own bot bubble, appended separately) still stays visible.
    this.activeChoiceEl?.remove();
    const wasNearBottom = this.isNearBottom();
    const wrap = document.createElement('div');
    wrap.className = 'la-chat-options';
    for (const option of options) {
      const btn = document.createElement('button');
      btn.className = 'la-chat-option';
      btn.type = 'button';
      btn.textContent = option;
      btn.onclick = () => {
        wrap.remove();
        if (this.activeChoiceEl === wrap) this.activeChoiceEl = null;
        this.submitUserValue(stepId, option, option);
      };
      wrap.appendChild(btn);
    }
    this.chatLogEl.appendChild(wrap);
    this.activeChoiceEl = wrap;
    this.scrollDownIfPinned(wasNearBottom);
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
    this.activeChoiceEl = null;
    this.resetChatLog();
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
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'), err);
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
    row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble">${skeletonLenderRowsHtml()}</div>`;
    this.chatLogEl.appendChild(row);
    this.scrollDown();
    return row;
  }

  /** Called the instant a profile-panel edit is submitted (see ProfilePanel's onEditStarted) —
   * bug fixed 2026-11-10 (CIS-reported): the stale, pre-edit eligibility cards used to just sit on
   * screen, unchanged, for the entire recalculation round-trip, with nothing indicating a
   * recalculation was even happening. Replaces the result card's current content with the same
   * skeleton placeholder used for the very first eligibility computation — applyUpdatedResult
   * (called once the recalculation actually finishes) already overwrites whatever's in
   * resultContainerEl with the fresh cards, so no other change was needed to complete the cycle. */
  private showResultRecalculating(): void {
    if (!this.resultCardShown) return; // nothing shown yet for this edit to be recalculating
    this.resultContainerEl.innerHTML = skeletonLenderRowsHtml();
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
        this.activeChoiceEl = null;
        this.resetChatLog();
        return this.start();
      }
      this.renderFatalError(describeApiError(err, 'Sorry, something went wrong on our end. Please try again in a moment.'), err);
    }
  }

  private renderFatalError(message = 'Sorry, something went wrong on our end. Please try again in a moment.', cause?: unknown) {
    this.productSwitchLoadingEl?.remove();
    this.productSwitchLoadingEl = null;
    // Reported here, in the one shared place every "customer is now looking at a broken widget"
    // path already funnels through, rather than at each of this method's call sites individually
    // (see errorReporter.ts's own doc comment for why this matters — these are deliberately-caught
    // failures that would otherwise leave zero record anywhere once the customer closes the tab).
    this.errorReporter.reportCaught(message, cause);
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

  // keepChatLog (2026-11-12 instruction) — a genuine "Start over" (the confirm-dialog path) should
  // still wipe the visible transcript, but switching products via open() with a new launchToken
  // should NOT: the customer typed/answered real things in the old product's conversation and
  // expects to still see them, not have the screen go blank the instant they click a different
  // card. The underlying session itself is never lost either way (see profile.service.ts/chat.ts's
  // per-product resume) — this only controls what's visibly on screen.
  private restart(opts?: { keepChatLog?: boolean }) {
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
    // Bug fixed 2026-11-12, then PARTIALLY REVERTED 2026-11-13: removing the DOM node here (not
    // just nulling the reference) was meant to stop an old product's still-unanswered choice
    // buttons from staying visible, live and clickable, right alongside the new product's content.
    // That's no longer a risk — switchProductLog (called a moment later, once the new product's
    // response actually arrives) now reliably stashes EVERY child of chatLogEl away per product,
    // buttons included, and restores them later exactly as they were. But deleting the node here,
    // BEFORE that stash ever runs, means it's gone for good the instant you switch away — so
    // switchProductLog has nothing left to stash, and coming back to that product later shows the
    // question text (restored fine) with no way to answer it at all (reported 2026-11-13: "LAP mein
    // typing box hi vanish ho gaya" — the "box" was these choice buttons). Only a genuine restart
    // (no keepChatLog — resetChatLog() below wipes the whole log anyway) still needs the DOM node
    // gone; a product switch just needs the reference cleared so a stray click can't double-submit
    // while the switch is in flight, and lets switchProductLog capture the real buttons untouched.
    if (!opts?.keepChatLog) this.activeChoiceEl?.remove();
    this.activeChoiceEl = null;
    // A genuine restart (never the product-switch/keepChatLog path) must tell the server this is
    // deliberate — see forceNewOnNextStart's own doc comment for why that distinction matters.
    if (!opts?.keepChatLog) this.forceNewOnNextStart = true;
    if (opts?.keepChatLog) {
      // Immediate feedback for a product switch (2026-11-12 instruction) — without this, the OLD
      // product's last question (now with its buttons gone per the fix above, but its TEXT still
      // sitting there) looks frozen for however long the switch's real network round trip takes
      // (a few seconds — dedupeCheck/profile-recall hit real Finfinity APIs), with nothing on
      // screen indicating anything is happening.
      // Bug fixed 2026-11-14 (reported: a permanent "Switching…" bubble stuck above the real first
      // message, on what looked like a fresh session) — if open() fires a second time with a
      // launchToken before the first switch's response has come back (restart() called twice in a
      // row), this used to just append ANOTHER loading row, leaving the first one's reference
      // overwritten and orphaned in the DOM forever — renderTurn only ever clears whatever
      // productSwitchLoadingEl currently points at, never any earlier one left behind. Removing any
      // stale one first means there's only ever at most one in the log at a time.
      this.productSwitchLoadingEl?.remove();
      this.clearComposer();
      const row = document.createElement('div');
      row.className = 'la-message';
      row.innerHTML = `<span class="la-avatar">${ICON.bot}</span><div class="la-bubble lc-loading-row"><div class="lc-spinner"></div><span class="lc-loading-label">Switching…</span></div>`;
      this.chatLogEl.appendChild(row);
      this.scrollDown();
      this.productSwitchLoadingEl = row;
    } else {
      this.resetChatLog();
    }
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
