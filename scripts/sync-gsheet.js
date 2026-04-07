#!/usr/bin/env node
/**
 * Sync all merchant tabs from the master Google Sheet into the Supabase DB.
 *
 * Uses the clasp OAuth token from ~/.clasprc.json (no extra setup needed).
 *
 * Usage:
 *   node scripts/sync-gsheet.js          # import all tabs
 *   node scripts/sync-gsheet.js "Soylent Nutrition, Inc."  # import one merchant
 */
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const MASTER_SPREADSHEET_ID = "1EWH3r21_plmWGK44h_vH3UqBlcoNc8HjTDdsQY23hDA";
const TARGET_MERCHANT = process.argv[2]?.trim() || null;

const RELEVANT_TYPES = new Set(["Refund", "LostInventory", "DamageInWarehouse", "InboundTransportationFee"]);

// --- Auth ---
function getAccessToken() {
  const clasprc = path.join(os.homedir(), ".clasprc.json");
  if (!fs.existsSync(clasprc)) throw new Error("~/.clasprc.json not found. Run: clasp login");
  const rc = JSON.parse(fs.readFileSync(clasprc, "utf-8"));
  const token = rc?.tokens?.default?.access_token || rc?.access_token;
  if (!token) throw new Error("No access_token in ~/.clasprc.json. Run: clasp login");
  return token;
}

// --- Sheets API helpers ---
async function sheetsApi(path, token) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function downloadSheetAsCsv(spreadsheetId, gid, token) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to download sheet gid=${gid}: ${res.status}`);
  return res.text();
}

// --- CSV parser ---
function parseDate(str) {
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

function parseCsv(csvText, merchantName) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());

  const idx = {
    transactionType: headers.findIndex(h => h === "transaction type"),
    reasonCode:      headers.findIndex(h => h === "reason code"),
    wfsReferenceId:  headers.findIndex(h => h.includes("wfsreferenceid")),
    date:            headers.findIndex(h => h.includes("transaction date")),
    qty:             headers.findIndex(h => h === "qty"),
    gtin:            headers.findIndex(h => h.includes("partner gtin")),
    netPayable:      headers.findIndex(h => h === "net payable"),
    poNumber:        headers.findIndex(h => h.includes("po #") || h === "walmart.com po #"),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || [];
    const get = (index) => index < 0 ? "" : (cols[index] || "").replace(/^"|"$/g, "").trim();

    const transactionType = get(idx.transactionType);
    if (!RELEVANT_TYPES.has(transactionType)) continue;

    const reasonCode = get(idx.reasonCode);
    if (transactionType === "Refund" && !reasonCode.toLowerCase().includes("inbound")) continue;

    const wfsReferenceId = get(idx.wfsReferenceId);
    if (!wfsReferenceId) continue;

    rows.push({
      merchantName,
      transactionType,
      reasonCode,
      wfsReferenceId,
      walmartPoNumber: get(idx.poNumber),
      partnerGtin: get(idx.gtin),
      quantity: parseInt(get(idx.qty)) || 1,
      netPayable: parseFloat(get(idx.netPayable).replace(/[^0-9.-]/g, "")) || 0,
      transactionDateTime: parseDate(get(idx.date)),
    });
  }
  return rows;
}

// --- Main ---
async function main() {
  const token = getAccessToken();

  // Get all sheets from the master spreadsheet
  const meta = await sheetsApi(`${MASTER_SPREADSHEET_ID}?fields=sheets.properties`, token);
  const sheets = meta.sheets.map(s => ({
    name: s.properties.title,
    gid: s.properties.sheetId,
    cleanName: s.properties.title.split("_")[0].trim(), // strip date suffix e.g. "Merchant_10/25/2024"
  })).filter(s => s.cleanName !== "Processing...");

  const targets = TARGET_MERCHANT
    ? sheets.filter(s => s.cleanName.toLowerCase() === TARGET_MERCHANT.toLowerCase())
    : sheets;

  if (!targets.length) {
    console.error(`No matching sheets found${TARGET_MERCHANT ? ` for "${TARGET_MERCHANT}"` : ""}.`);
    console.log("Available merchants:", sheets.map(s => s.cleanName).join(", "));
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  let totalAdded = 0, totalSkipped = 0;

  for (const sheet of targets) {
    process.stdout.write(`Syncing "${sheet.cleanName}"... `);
    try {
      const csv = await downloadSheetAsCsv(MASTER_SPREADSHEET_ID, sheet.gid, token);
      const rows = parseCsv(csv, sheet.cleanName);

      if (!rows.length) {
        console.log("0 relevant rows.");
        continue;
      }

      const result = await prisma.settlementClaim.createMany({
        data: rows,
        skipDuplicates: true,
      });

      totalAdded += result.count;
      totalSkipped += rows.length - result.count;
      console.log(`Added ${result.count} | Skipped ${rows.length - result.count}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  console.log(`\nDone. Total added: ${totalAdded} | Total skipped: ${totalSkipped}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  process.exit(1);
});
