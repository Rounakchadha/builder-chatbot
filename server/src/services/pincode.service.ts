import { logger } from '../lib/logger';

export interface PincodeService {
  /** Resolves a 6-digit Indian pincode to its district/area name, e.g. "400051" -> "Mumbai".
   * Returns null on any lookup failure — this is a display nicety, never a reason to block the flow. */
  lookupArea(pincode: string): Promise<string | null>;
}

interface PostOfficeResult {
  Status: string;
  PostOffice?: Array<{ District: string; State: string }>;
}

/** Free, keyless public India Post lookup — no mock/real credential swap needed here since there's
 * no auth to configure either way. */
class PostalPincodeService implements PincodeService {
  async lookupArea(pincode: string): Promise<string | null> {
    try {
      const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = (await res.json()) as PostOfficeResult[];
      const po = data[0]?.PostOffice?.[0];
      if (data[0]?.Status !== 'Success' || !po) return null;
      return po.District;
    } catch (err) {
      logger.warn({ err, pincode }, 'pincode area lookup failed — continuing without it');
      return null;
    }
  }
}

export const pincodeService: PincodeService = new PostalPincodeService();
