import { encryptPii, maskPan } from '../lib/crypto';
import { prisma } from '../lib/prisma';

export interface CreateCustomerInput {
  mobileHash: string;
  mobileMasked: string;
  pan: string;
  name: string;
  dob: string;
  email: string;
  pincode: string;
  segment: string;
  creditScore: number;
  bureauSource: 'bureau' | 'experian';
}

/** Our own persisted identity record — not an external API, just the data layer behind the
 * dedupe check and the "create customer once bureau consent + PAN are collected" step. */
export const customerService = {
  async create(input: CreateCustomerInput): Promise<{ id: string }> {
    const customer = await prisma.customer.create({
      data: {
        mobileHash: input.mobileHash,
        mobileMasked: input.mobileMasked,
        panEncrypted: encryptPii(input.pan),
        panMasked: maskPan(input.pan),
        nameEncrypted: encryptPii(input.name),
        dob: input.dob,
        email: input.email,
        pincode: input.pincode,
        segment: input.segment,
        creditScore: input.creditScore,
        bureauSource: input.bureauSource,
      },
    });
    return { id: customer.id };
  },

  /** Fills in a field that was missing at dedupe time (email/pincode/segment/creditScore) — never
   * overwrites one that's already on file. */
  async updateMissingField(customerId: string, field: 'email' | 'pincode' | 'segment' | 'creditScore', value: string | number): Promise<void> {
    await prisma.customer.update({ where: { id: customerId }, data: { [field]: value } });
  },

  /** Caches a just-fetched CIBIL/Experian score by mobileHash so a REAL dedupe-found customer
   * (whose remote profile has no local `customerId` to hang updateMissingField off of — see
   * dedupe.service.ts) doesn't have to redo the bureau-consent OTP on every single future
   * eligibility check just to re-learn a score we already pulled once. Only touches creditScore/
   * bureauSource — never clobbers any other field an existing row might already carry. */
  async cacheBureauScore(mobileHash: string, mobileMasked: string, creditScore: number, bureauSource: 'bureau' | 'experian'): Promise<void> {
    await prisma.customer.upsert({
      where: { mobileHash },
      create: { mobileHash, mobileMasked, creditScore, bureauSource },
      update: { creditScore, bureauSource },
    });
  },

  /** Null if this number has never had a score cached — the caller's job to fall back to running
   * the real bureau-consent OTP in that case. */
  async findCachedBureauScore(mobileHash: string): Promise<{ creditScore: number; bureauSource: string } | null> {
    const customer = await prisma.customer.findUnique({ where: { mobileHash }, select: { creditScore: true, bureauSource: true } });
    if (!customer?.creditScore) return null;
    return { creditScore: customer.creditScore, bureauSource: customer.bureauSource ?? 'bureau' };
  },
};
