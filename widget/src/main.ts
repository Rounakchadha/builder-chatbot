import { ChatWidget } from './app';

function injectFonts() {
  if (document.getElementById('lc-fonts')) return;
  const link = document.createElement('link');
  link.id = 'lc-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  document.head.appendChild(link);
}

// document.currentScript is only valid during this script's synchronous initial
// execution — must capture it now, not inside the (possibly deferred) init() call.
const scriptEl = document.currentScript as HTMLScriptElement | null;

function init() {
  const apiBaseUrl = scriptEl?.dataset.apiBase ?? '';
  if (!apiBaseUrl) {
    console.error('[loan-chat-widget] Missing data-api-base attribute on the widget <script> tag.');
    return;
  }
  injectFonts();
  new ChatWidget({ apiBaseUrl });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
