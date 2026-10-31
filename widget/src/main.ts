import { ChatWidget } from './app';

declare global {
  interface Window {
    FinfinityWidgetConfig?: { apiBase?: string; theme?: Record<string, string> };
    __lcWidgetInstance?: ChatWidget;
  }
}

// document.currentScript is only valid during this script's synchronous initial
// execution — must capture it now, not inside the (possibly deferred) init() call.
const scriptEl = document.currentScript as HTMLScriptElement | null;

// Security-review finding, 2026-10-23: document.currentScript is null whenever this script loads
// async/defer or is injected by a tag manager (e.g. GTM) rather than a plain synchronous <script>
// tag — data-api-base was then silently lost with just one console.error. Two fallbacks, in order:
// (1) find the script tag by its own data attribute instead of relying on which one was "current",
// which works for defer/async since the tag itself still has the attribute; (2) a host page using
// GTM (where there may be no identifiable <script> tag at all) can set a global config object
// before the widget loads instead.
function resolveApiBaseUrl(): string {
  if (scriptEl?.dataset.apiBase) return scriptEl.dataset.apiBase;
  const byAttribute = document.querySelector<HTMLScriptElement>('script[data-api-base]');
  if (byAttribute?.dataset.apiBase) return byAttribute.dataset.apiBase;
  return window.FinfinityWidgetConfig?.apiBase ?? '';
}

/** Same resolution order as resolveApiBaseUrl above — so a host page that already has its own
 * chat-entry-point UI can suppress this widget's launcher button (`data-hide-launcher`) and open
 * it from their own button instead via `window.__lcWidgetInstance.open()`. */
function resolveHideLauncher(): boolean {
  if (scriptEl?.dataset.hideLauncher !== undefined) return scriptEl.dataset.hideLauncher !== 'false';
  const byAttribute = document.querySelector<HTMLScriptElement>('script[data-hide-launcher]');
  if (byAttribute?.dataset.hideLauncher !== undefined) return byAttribute.dataset.hideLauncher !== 'false';
  return false;
}

/** Same resolution order again, for a host site re-skinning the widget to match its own brand (see
 * ChatWidgetOptions.theme's doc comment in app.ts) — `data-theme` holds a JSON object of this
 * widget's own CSS custom property names to values, e.g. `data-theme='{"--lc-primary":"#945ef0"}'`.
 * A malformed value is logged and ignored rather than breaking the whole widget over a typo. */
function resolveTheme(): Record<string, string> | undefined {
  const raw = scriptEl?.dataset.theme ?? document.querySelector<HTMLScriptElement>('script[data-theme]')?.dataset.theme;
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch (err) {
      console.error('[loan-chat-widget] data-theme is not valid JSON — ignoring it.', err);
    }
  }
  return window.FinfinityWidgetConfig?.theme;
}

function init() {
  // Security-review finding, 2026-10-23: nothing stopped this script running twice on one page
  // (e.g. included by both a theme and a plugin, or re-run on an SPA route change) — that used to
  // just mount a second, fully independent chat widget. One instance per page now; a re-run
  // destroys the previous one first (see ChatWidget.destroy below) rather than being ignored
  // outright, so an SPA that intentionally re-inits after a route change still gets a working widget.
  if (window.__lcWidgetInstance) {
    console.warn('[loan-chat-widget] Already initialized on this page — replacing the existing instance.');
    window.__lcWidgetInstance.destroy();
  }

  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    console.error('[loan-chat-widget] Missing data-api-base attribute on the widget <script> tag (and no window.FinfinityWidgetConfig.apiBase fallback either).');
    return;
  }
  window.__lcWidgetInstance = new ChatWidget({ apiBaseUrl, hideLauncher: resolveHideLauncher(), theme: resolveTheme() });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
