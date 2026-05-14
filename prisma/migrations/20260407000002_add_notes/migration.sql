CREATE TABLE IF NOT EXISTS "notes" (
    "note_key" TEXT NOT NULL,
    "note_text" TEXT NOT NULL,
    "note_color" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notes_pkey" PRIMARY KEY ("note_key")
);

ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON "notes"
  FOR ALL USING (true) WITH CHECK (true);
