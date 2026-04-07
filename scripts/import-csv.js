#!/usr/bin/env node
/**
 * Import a Walmart WFS settlement CSV into the Supabase DB.
 * Usage: node scripts/import-csv.js <path-to-csv> <merchantName>
 * Example: node scripts/import-csv.js "C:/Users/Cedric/Pictures/Soylent.csv" "Soylent Nutrition, Inc."
 */
import "dotenv/config";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const [,, csvPath, merchantName] = process.argv;

if (!csvPath || !merchantName) {
  console.error("Usage: node scripts/import-csv.js <csv-path> <merchantName>");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const RELEVANT_TYPES = new Set(["Refund", "LostInventory", "DamageInWarehouse", "InboundTransportationFee"]);

function parseDate(str) {
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

async function main() {
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));

  const idx = {
    transactionType: headers.findIndex(h => h === "transaction type"),
    reasonCode:      headers.findIndex(h => h === "reason code"),
    wfsReferenceId:  headers.findIndex(h => h.includes("wfsreferenceid")),
    date:            headers.findIndex(h => h.includes("transaction date")),
    qty:             headers.findIndex(h => h === "qty"),
    gtin:            headers.findIndex(h => h.includes("partner gtin")),
    netPayable:      headers.findIndex(h => h === "net payable"),
    poNumber:        headers.findIndex(h => h.includes("walmart.com po #") || h.includes("po #")),
  };

  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    // naive CSV parse (handles quoted fields)
    const cols = lines[i].match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || [];
    const get = (index) => (cols[index] || "").replace(/^"|"$/g, "").trim();

    const transactionType = get(idx.transactionType);
    if (!RELEVANT_TYPES.has(transactionType)) continue;

    const reasonCode = get(idx.reasonCode);
    if (transactionType === "Refund" && !reasonCode.toLowerCase().includes("inbound")) continue;

    const wfsReferenceId = get(idx.wfsReferenceId);
    if (!wfsReferenceId) continue;

    const netPayable = parseFloat(get(idx.netPayable).replace(/[^0-9.-]/g, "")) || 0;
    const quantity   = parseInt(get(idx.qty)) || 1;
    const transactionDateTime = parseDate(get(idx.date));
    const partnerGtin   = get(idx.gtin);
    const walmartPoNumber = get(idx.poNumber);

    rows.push({
      merchantName,
      transactionType,
      reasonCode,
      wfsReferenceId,
      walmartPoNumber,
      partnerGtin,
      quantity,
      netPayable,
      transactionDateTime,
    });
  }

  if (rows.length === 0) {
    console.log("No relevant rows found in this file.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${rows.length} relevant rows. Importing...`);

  const result = await prisma.settlementClaim.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(`✓ Imported: ${result.count} | Skipped (duplicates): ${rows.length - result.count}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
