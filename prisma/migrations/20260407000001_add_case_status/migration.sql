CREATE TABLE "CaseStatus" (
    "id" TEXT NOT NULL,
    "gtin" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseStatus_caseId_key" ON "CaseStatus"("caseId");

ALTER TABLE "CaseStatus" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON "CaseStatus"
  FOR ALL USING (true) WITH CHECK (true);
