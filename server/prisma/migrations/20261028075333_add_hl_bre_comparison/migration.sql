-- CreateTable
CREATE TABLE "HlBreComparison" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "leadId" TEXT,
    "facts" JSONB NOT NULL,
    "realChainResults" JSONB NOT NULL,
    "ownBreResults" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HlBreComparison_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HlBreComparison_conversationId_idx" ON "HlBreComparison"("conversationId");

-- AddForeignKey
ALTER TABLE "HlBreComparison" ADD CONSTRAINT "HlBreComparison_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
