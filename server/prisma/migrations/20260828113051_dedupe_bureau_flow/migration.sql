-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "customerId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "mobileHash" TEXT NOT NULL,
    "mobileMasked" TEXT NOT NULL,
    "panEncrypted" TEXT,
    "panMasked" TEXT,
    "nameEncrypted" TEXT,
    "dob" TEXT,
    "email" TEXT,
    "pincode" TEXT,
    "segment" TEXT,
    "creditScore" INTEGER,
    "bureauSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_mobileHash_key" ON "Customer"("mobileHash");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
