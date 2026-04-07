"use server";

import * as xlsx from "xlsx";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis;
const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function processSettlementFile(formData) {
  try {
    const file = formData.get("file");
    const merchantName = formData.get("merchantName");

    if (!file) return { success: false, error: "No file attached to the request." };
    if (!merchantName) return { success: false, error: "Merchant name is missing. Select or enter a client name before uploading." };

    const arrayBuffer = await file.arrayBuffer();
    const workbook = xlsx.read(arrayBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    let headerRowIndex = -1;
    let headers = [];
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (row && row.some(cell => String(cell).trim().toLowerCase() === "transaction type")) {
           headerRowIndex = i;
           headers = row.map(h => String(h).trim().toLowerCase());
           break;
        }
    }

    if (headerRowIndex === -1) {
       return { success: false, error: "Could not find a 'Transaction Type' column. Make sure this is a WFS Settlement export (CSV or XLSX)." };
    }

    const typeColIndex = headers.indexOf('transaction type');
    const reasonColIndex = headers.indexOf('reason code');
    const refIdColIndex = headers.findIndex(h => h.includes('wfsreferenceid'));
    const netPayColIndex = headers.indexOf('net payable');
    const dateColIndex = headers.indexOf('transaction date/time');
    
    // Additional essential columns for accurate crossmatching
    const poColIndex = headers.findIndex(h => h.includes('walmart.com po #'));
    const gtinColIndex = headers.findIndex(h => h.includes('partner gtin') || h === 'gtin');
    const qtyColIndex = headers.findIndex(h => h === 'qty' || h === 'quantity');

    const missingCols = [
      refIdColIndex === -1 && "WFSReferenceId",
      netPayColIndex === -1 && "Net Payable",
      dateColIndex === -1 && "Transaction Date/Time",
    ].filter(Boolean);
    if (missingCols.length) {
      return { success: false, error: `Missing required columns: ${missingCols.join(", ")}. Verify the file is a complete WFS Settlement export.` };
    }

    const relevantTransactionTypes = new Set(['Refund', 'LostInventory', 'DamageInWarehouse', 'InboundTransportationFee']);
    const parsedRows = [];
    const warnings = [];

    // Read GTIN directly from the sheet cell to avoid scientific notation precision loss.
    // xlsx parses "8.50036E+11" from CSV text as 850036000000 (truncated). Direct cell
    // access gives us cell.v which, for XLSX files, is the full precise integer.
    const getGtinFromCell = (rowIdx) => {
      if (gtinColIndex < 0) return '';
      const addr = xlsx.utils.encode_cell({ r: rowIdx, c: gtinColIndex });
      const cell = sheet[addr];
      if (!cell || cell.v == null) return '';
      if (cell.t === 'n') {
        // For XLSX: cell.v is the precise stored number (safe for integers < 2^53)
        // For CSV: xlsx already parsed the scientific notation, precision may be lost
        const numStr = String(Math.round(cell.v));
        // Flag suspicious GTINs: if a 10+ digit number ends in 4+ zeros it was likely
        // scientific-notation in the source CSV (e.g. 850036000000 vs 850036463405)
        if (numStr.length >= 10 && /0{4,}$/.test(numStr)) {
          warnings.push(`GTIN ${numStr} may be truncated (scientific notation in source CSV). Format GTIN column as Text in Excel before exporting.`);
        }
        return numStr;
      }
      if (cell.t === 's') {
        const s = cell.v.trim().replace(/,/g, '');
        if (/^[\d.]+[eE][+\-]?\d+$/i.test(s)) {
          const numStr = String(Math.round(parseFloat(s)));
          warnings.push(`GTIN ${numStr} may be truncated — source cell was in scientific notation (${s}). Format GTIN column as Text in Excel.`);
          return numStr;
        }
        return s.replace(/[^0-9]/g, '');
      }
      return String(cell.v);
    };

    const dataRows = data.slice(headerRowIndex + 1);

    let dataRowOffset = 0;
    for (const row of dataRows) {
      const sheetRowIdx = headerRowIndex + 1 + dataRowOffset;
      dataRowOffset++;

      if (!row || !row.length) continue;
      const transactionType = String(row[typeColIndex] || "").trim();
      const reasonCode = String(row[reasonColIndex] || "").trim();
      const wfsReferenceId = String(row[refIdColIndex] || "").trim();
      const netPayableStr = row[netPayColIndex] != null ? String(row[netPayColIndex]).trim() : "";

      let dateVal = row[dateColIndex];
      let dateStr = dateVal != null ? String(dateVal).trim() : "";

      if (!transactionType || !relevantTransactionTypes.has(transactionType)) continue;
      if (transactionType === 'Refund' && !reasonCode.toLowerCase().includes('inbound')) {
         continue;
      }

      if (!wfsReferenceId) continue;

      let netPayable = parseFloat(netPayableStr.replace(/[^0-9.-]+/g,""));
      const poVal = poColIndex > -1 ? String(row[poColIndex] || "").trim() : "";
      const gtinVal = getGtinFromCell(sheetRowIdx);
      const qtyVal = qtyColIndex > -1 ? parseInt(row[qtyColIndex]) : 1;
      
      let transactionDateTime;
      if (typeof dateVal === 'number') {
        // Excel serial date
        transactionDateTime = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
      } else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(dateStr)) {
        // US format M/D/YYYY or M/D/YYYY H:MM
        const [datePart] = dateStr.split(' ');
        const [m, d, y] = datePart.split('/');
        transactionDateTime = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      } else {
        // ISO format YYYY-MM-DD or fallback
        transactionDateTime = new Date(dateStr);
      }

      parsedRows.push({
          merchantName,
          transactionType,
          reasonCode,
          wfsReferenceId,
          walmartPoNumber: poVal,
          partnerGtin: gtinVal,
          quantity: isNaN(qtyVal) ? 1 : qtyVal,
          netPayable: isNaN(netPayable) ? 0 : netPayable,
          transactionDateTime: isNaN(transactionDateTime.getTime()) ? new Date() : transactionDateTime
      });
    }

    let added = 0;
    let skipped = 0;

    // Use Prisma createMany with skipDuplicates (ideal for bulk insert with unique constraints)
    try {
        const result = await prisma.settlementClaim.createMany({
            data: parsedRows,
            skipDuplicates: true, 
        });
        added = result.count;
        skipped = parsedRows.length - added;
    } catch (e) {
        console.error("Bulk insert failed:", e);
        const msg = e?.message || "";
        if (msg.includes("connect")) return { success: false, error: "Database connection failed. Check DATABASE_URL environment variable." };
        if (msg.includes("unique")) return { success: false, error: "Duplicate key error during insert. Try enabling skip duplicates." };
        return { success: false, error: `Database insert error: ${msg.slice(0, 120)}` };
    }

    return { success: true, added, skipped, warnings: [...new Set(warnings)] };
    
  } catch (error) {
    console.error("Upload error:", error);
    const msg = error?.message || "Unknown error";
    if (msg.includes("maxBodyLength") || msg.includes("size")) return { success: false, error: "File too large. Max upload size is 10MB." };
    return { success: false, error: `Upload failed: ${msg.slice(0, 200)}` };
  }
}

export async function fetchClaims(merchantName) {
   const whereClause = merchantName ? { merchantName } : {};
   return await prisma.settlementClaim.findMany({
       where: whereClause,
       orderBy: { transactionDateTime: 'desc' },
       take: 50
   });
}

export async function fetchCrosscheckData(merchantName) {
   // Empty string = all clients
   const where = merchantName ? { merchantName } : {};
   return await prisma.settlementClaim.findMany({ where });
}

export async function getMerchants() {
    const records = await prisma.settlementClaim.findMany({
        distinct: ['merchantName'],
        select: { merchantName: true }
    });
    return records.map(c => c.merchantName);
}

export async function fetchCaseStatuses(gtins) {
    // gtins: array of normalized GTINs (leading zeros stripped)
    if (!gtins || gtins.length === 0) return [];
    return await prisma.caseStatus.findMany({
        where: { gtin: { in: gtins } },
        select: { gtin: true, caseId: true, status: true }
    });
}

export async function importCaseStatuses(rows) {
    // rows: [{ gtin, caseId, status }]
    if (!rows.length) return { added: 0, skipped: 0 };
    let added = 0, skipped = 0;
    for (const row of rows) {
        try {
            await prisma.caseStatus.upsert({
                where: { caseId: row.caseId },
                update: { gtin: row.gtin, status: row.status },
                create: row,
            });
            added++;
        } catch {
            skipped++;
        }
    }
    return { added, skipped };
}
