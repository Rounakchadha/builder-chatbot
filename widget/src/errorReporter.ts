/** Reports widget crashes/errors back to our own server (see server/src/routes/widgetError.ts) so
 * they show up in the normal server logs instead of vanishing the moment that one customer closes
 * the tab — this was a real blind spot found 2026-11-07: the server already logs every API failure,
 * but a JS crash or stuck flow in the widget itself left no record anywhere except that customer's
 * own (almost never open) devtools console.
 *
 * Best-effort only, by design: if reporting itself fails (network down, a new partner's CORS not
 * set up yet, sendBeacon unsupported, whatever) it's swallowed silently. A crash reporter that can
 * itself throw or block the page is worse than having no crash reporter at all. */

const MAX_REPORTS_PER_INSTANCE = 20;
const MAX_STRING_LEN = 4000;
// Matches this bundle's own fixed output filename (see vite.config.mts's `fileName: () =>
// 'widget.js'`) — used to tell "a bug in OUR code" apart from "some unrelated error happening
// elsewhere on the host page" (their own scripts, a GTM tag, a browser extension), so this doesn't
// turn into a dumping ground for noise that isn't ours to fix.
const OWN_BUNDLE_MARKER = 'widget.js';

type ReportSource = 'window-error' | 'unhandled-rejection' | 'fatal-render';

export class ErrorReporter {
  private sent = 0;
  private seen = new Set<string>();
  private teardownFns: Array<() => void> = [];

  constructor(
    private apiBaseUrl: string,
    private getSessionToken: () => string | null,
  ) {}

  /** Starts listening for uncaught errors/rejections on the host page's `window` — not just inside
   * this widget's own code, since the shadow root only isolates CSS/DOM, not the JS realm: a bug in
   * one of this widget's own event handlers still throws as an ordinary uncaught error on the same
   * `window` the host page uses. */
  start(): void {
    const onError = (e: ErrorEvent) => {
      if (!this.looksLikeOurs(e.filename, e.error instanceof Error ? e.error.stack : undefined)) return;
      this.report('window-error', e.message, e.error instanceof Error ? e.error.stack : undefined);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const stack = reason instanceof Error ? reason.stack : undefined;
      if (!this.looksLikeOurs(undefined, stack)) return;
      this.report('unhandled-rejection', reason instanceof Error ? reason.message : String(reason), stack);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.teardownFns.push(() => window.removeEventListener('error', onError));
    this.teardownFns.push(() => window.removeEventListener('unhandledrejection', onRejection));
  }

  /** Mirrors ChatWidget's own cleanupFns pattern (see app.ts's destroy()) — called from there so a
   * destroyed widget instance doesn't leave a stray window-level listener behind. */
  stop(): void {
    for (const fn of this.teardownFns) fn();
    this.teardownFns = [];
  }

  /** For the widget's own already-caught failure paths (renderFatalError) — these are deliberately
   * caught, so they never reach window.onerror/unhandledrejection at all, but they're exactly the
   * moments a real customer is looking at a broken widget, so they matter just as much as an
   * uncaught crash. */
  reportCaught(message: string, cause?: unknown): void {
    this.report('fatal-render', message, cause instanceof Error ? cause.stack : undefined);
  }

  private looksLikeOurs(filename?: string, stack?: string): boolean {
    return Boolean(filename?.includes(OWN_BUNDLE_MARKER) || stack?.includes(OWN_BUNDLE_MARKER));
  }

  private report(source: ReportSource, message: string, stack?: string): void {
    try {
      if (this.sent >= MAX_REPORTS_PER_INSTANCE) return; // a crash loop shouldn't flood the server
      const signature = `${source}:${message}`.slice(0, 200);
      if (this.seen.has(signature)) return; // already reported this exact error once — that's enough to know about it
      this.seen.add(signature);
      this.sent++;

      const payload = JSON.stringify({
        source,
        message: message.slice(0, MAX_STRING_LEN),
        stack: stack?.slice(0, MAX_STRING_LEN),
        pageUrl: window.location.href.slice(0, MAX_STRING_LEN),
        userAgent: navigator.userAgent.slice(0, 500),
        sessionToken: this.getSessionToken() ?? undefined,
      });

      const url = `${this.apiBaseUrl}/api/widget-error`;
      // sendBeacon survives the page unloading right after a crash (a plain fetch can get cancelled
      // mid-flight in that moment) — falls back to a fire-and-forget keepalive fetch wherever
      // sendBeacon isn't available or its own Blob construction fails.
      if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))) {
        return;
      }
      void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
    } catch {
      // Reporting a crash must never itself throw or block anything — see this class's own doc comment.
    }
  }
}
