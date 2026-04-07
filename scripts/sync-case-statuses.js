#!/usr/bin/env node
/**
 * Sync case statuses from the WFS Main RMS Report Google Sheet into Supabase.
 * Reads the "All Client RMS Report" tab and imports Declined/Pending cases.
 *
 * Usage: node scripts/sync-case-statuses.js
 *
 * Requires Google Sheets API enabled (same as sync-gsheet.js).
 */
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const WFS_MAIN_RMS_SPREADSHEET_ID = "1F4G6g6nqyOgnf5VOhWNo8nJKWEJo4CcemcIygIMKEcE";
const SHEET_NAME = "All Client RMS Report";

function getAccessToken() {
  const clasprc = path.join(os.homedir(), ".clasprc.json");
  if (!fs.existsSync(clasprc)) throw new Error("~/.clasprc.json not found. Run: clasp login");
  const rc = JSON.parse(fs.readFileSync(clasprc, "utf-8"));
  const token = rc?.tokens?.default?.access_token || rc?.access_token;
  if (!token) throw new Error("No access_token in ~/.clasprc.json. Run: clasp login");
  return token;
}

async function sheetsApi(path, token) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = getAccessToken();

  console.log(`Fetching "${SHEET_NAME}" from WFS Main RMS spreadsheet...`);
  const data = await sheetsApi(
    `${WFS_MAIN_RMS_SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}`,
    token
  );

  const rows = data.values || [];
  if (rows.length < 2) { console.log("No data found."); return; }

  const headers = rows[0].map(h => h.trim());
  const col = {
    gtin:                headers.indexOf("GTIN"),
    caseId:              headers.indexOf("Case ID"),
    caseStatus:          headers.indexOf("Case Status"),
    reimbursementStatus: headers.indexOf("Reimbursement Status"),
  };

  const missing = Object.entries(col).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) {
    console.error("Missing columns:", missing.join(", "));
    console.error("Available columns:", headers.join(", "));
    process.exit(1);
  }

  const toImport = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const gtin = (row[col.gtin] || "").trim();
    const caseId = (row[col.caseId] || "").trim();
    if (!gtin || !caseId) continue;

    const cs = (row[col.caseStatus] || "").toLowerCase();
    const rs = (row[col.reimbursementStatus] || "").toLowerCase();

    let status = null;
    if (cs.includes("in progress")) status = "Pending";
    else if (rs.includes("declined")) status = "Declined";
    if (!status) continue;

    toImport.push({ gtin: gtin.replace(/^0+/, ""), caseId, status });
  }

  console.log(`Found ${toImport.length} relevant case statuses (Pending/Declined).`);
  if (!toImport.length) return;

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  let added = 0, updated = 0;
  for (const row of toImport) {
    const existing = await prisma.caseStatus.findUnique({ where: { caseId: row.caseId } });
    if (existing) {
      await prisma.caseStatus.update({ where: { caseId: row.caseId }, data: { status: row.status, gtin: row.gtin } });
      updated++;
    } else {
      await prisma.caseStatus.create({ data: row });
      added++;
    }
  }

  console.log(`✓ Added: ${added} | Updated: ${updated}`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e.message); process.exit(1); });
