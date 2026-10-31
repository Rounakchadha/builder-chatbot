-- DropForeignKey
ALTER TABLE "ConsentAudit" DROP CONSTRAINT "ConsentAudit_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "FlowAnswer" DROP CONSTRAINT "FlowAnswer_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "PlBreComparison" DROP CONSTRAINT "PlBreComparison_conversationId_fkey";

-- AlterTable
ALTER TABLE "ConsentAudit" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'mobile_step';

-- CreateIndex
CREATE INDEX "ConsentAudit_conversationId_idx" ON "ConsentAudit"("conversationId");

-- CreateIndex
CREATE INDEX "Conversation_createdAt_idx" ON "Conversation"("createdAt");

-- CreateIndex
CREATE INDEX "Lead_builderLeadId_idx" ON "Lead"("builderLeadId");

-- CreateIndex
CREATE INDEX "PlBreComparison_conversationId_idx" ON "PlBreComparison"("conversationId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowAnswer" ADD CONSTRAINT "FlowAnswer_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlBreComparison" ADD CONSTRAINT "PlBreComparison_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentAudit" ADD CONSTRAINT "ConsentAudit_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
