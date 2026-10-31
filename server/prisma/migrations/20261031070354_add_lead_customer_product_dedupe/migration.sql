-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "product" TEXT,
ADD COLUMN     "remoteCustomerId" INTEGER;

-- CreateIndex
CREATE INDEX "Lead_remoteCustomerId_product_idx" ON "Lead"("remoteCustomerId", "product");
