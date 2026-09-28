/** The widget renders every botMessage via innerHTML (deliberately, so `<strong>` emphasis works)
 * — any user-typed or third-party-API value spliced into one of those strings without this would
 * be a stored/reflected XSS hole. Applies to anything NOT a fixed English sentence or a value
 * already constrained to a safe character set by its own validation (e.g. a 6-digit pincode). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
