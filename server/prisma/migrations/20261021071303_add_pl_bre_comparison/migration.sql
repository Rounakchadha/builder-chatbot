-- CreateTable
CREATE TABLE "PlBreComparison" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "leadId" TEXT,
    "facts" JSONB NOT NULL,
    "realChainOffers" JSONB NOT NULL,
    "ownBreOffers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlBreComparison_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PlBreComparison" ADD CONSTRAINT "PlBreComparison_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
