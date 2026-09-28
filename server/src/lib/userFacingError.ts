/** An error whose message is already safe and intended to be shown to the customer as-is (e.g.
 * "too many OTP requests"). Everything else — a raw network failure, an unconfigured service, an
 * internal bank error_msg — must NOT reach the customer verbatim, since it can name internal
 * services/endpoints; those get replaced with a generic message instead (see routes/chat.ts).
 *
 * `action` lets the widget show something other than the default "Try again" button for a
 * none-type (apiFetch) step's error — 'restart' for a genuine dead end where retrying the same
 * step can only ever fail the same way again (e.g. a PAN/email that's still a duplicate on a
 * second attempt), so the customer gets a button that actually leads somewhere. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    public readonly action?: 'restart',
  ) {
    super(message);
  }
}
