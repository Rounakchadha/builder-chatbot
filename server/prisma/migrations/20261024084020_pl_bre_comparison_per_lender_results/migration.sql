-- Widened to full per-lender results (eligible or not, with reasons) instead of just the
-- approved-offer list — a plain rename preserves the 4 existing rows' data as-is (narrower shape,
-- still valid JSON) rather than dropping them.
ALTER TABLE "PlBreComparison" RENAME COLUMN "realChainOffers" TO "realChainResults";
ALTER TABLE "PlBreComparison" RENAME COLUMN "ownBreOffers" TO "ownBreResults";
