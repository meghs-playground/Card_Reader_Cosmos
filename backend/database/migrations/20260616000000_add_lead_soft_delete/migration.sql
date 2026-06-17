-- Soft delete (Trash) for leads. Idempotent so a re-run can't break startup.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "leads_deletedAt_idx" ON "leads"("deletedAt");
