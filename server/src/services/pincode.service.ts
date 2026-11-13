import { logger } from '../lib/logger';
import pincodeCityBackup from '../data/pincodeCityBackup.json';

export interface PincodeService {
  /** Resolves a 6-digit Indian pincode to its district/area name, e.g. "400051" -> "Mumbai".
   * Returns null on any lookup failure — this is a display nicety, never a reason to block the flow. */
  lookupArea(pincode: string): Promise<string | null>;
}

interface PostOfficeResult {
  Status: string;
  PostOffice?: Array<{ District: string; State: string }>;
}

// Local offline backup (2026-11-13 instruction) — the user's own "Serviceable pincodes_30062025.xlsx"
// (PIN/Zone/State/City/District columns), converted once to this JSON. Used ONLY when the live
// India Post API fails (timeout, outage, or a pincode it doesn't recognize) — confirmed live this
// session that a webhook field (`city`) silently shipped empty to CIS in exactly that failure
// window, so this exists to close that gap rather than for everyday use. Not guaranteed to be as
// current/precise as the live API (e.g. Delhi-area entries show the broad "NCR" rather than a
// specific locality) — a reasonable non-empty fallback, not a replacement.
const PINCODE_CITY_BACKUP = pincodeCityBackup as Record<string, string>;

/** Free, keyless public India Post lookup — no mock/real credential swap needed here since there's
 * no auth to configure either way. */
class PostalPincodeService implements PincodeService {
  async lookupArea(pincode: string): Promise<string | null> {
    try {
      const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return this.fallback(pincode);
      const data = (await res.json()) as PostOfficeResult[];
      const po = data[0]?.PostOffice?.[0];
      if (data[0]?.Status !== 'Success' || !po) return this.fallback(pincode);
      return po.District;
    } catch (err) {
      logger.warn({ err, pincode }, 'pincode area lookup failed — falling back to the local offline list');
      return this.fallback(pincode);
    }
  }

  private fallback(pincode: string): string | null {
    const city = PINCODE_CITY_BACKUP[pincode];
    if (city) logger.info({ pincode }, 'pincode area resolved from the local offline backup, not the live API');
    return city ?? null;
  }
}

export const pincodeService: PincodeService = new PostalPincodeService();
