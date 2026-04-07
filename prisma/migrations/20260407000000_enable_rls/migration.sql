-- Enable Row Level Security on SettlementClaim
ALTER TABLE "SettlementClaim" ENABLE ROW LEVEL SECURITY;

-- Allow all operations from the service role (used by Prisma via DATABASE_URL)
CREATE POLICY "service_role_full_access" ON "SettlementClaim"
  FOR ALL
  USING (true)
  WITH CHECK (true);
