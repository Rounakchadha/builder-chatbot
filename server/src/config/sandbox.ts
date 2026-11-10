import { env } from './env';

/** See SANDBOX_TEST_PAN/SANDBOX_TEST_MOBILE's doc comment in env.ts. Case-insensitive on PAN since
 * customers' typed PANs are normalized inconsistently across the codebase. */
export function isSandboxPan(pan?: string): boolean {
  return !!env.SANDBOX_TEST_PAN && !!pan && pan.toUpperCase() === env.SANDBOX_TEST_PAN.toUpperCase();
}

export function isSandboxMobile(mobile?: string): boolean {
  return !!env.SANDBOX_TEST_MOBILE && !!mobile && mobile === env.SANDBOX_TEST_MOBILE;
}
