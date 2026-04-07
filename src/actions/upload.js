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

    if (!file || !merchantName) {
      return { success: false, error: "File and Merchant Name are required." };
    }

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
       return { success: false, error: "Could not find 'Transaction Type' header." };
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

    if (refIdColIndex === -1 || netPayColIndex === -1 || dateColIndex === -1) {
       return { success: false, error: "Missing required columns: WFSReferenceID, Net Payable, or Transaction Date/Time" };
    }

    const relevantTransactionTypes = new Set(['Refund', 'LostInventory', 'DamageInWarehouse', 'InboundTransportationFee']);
    const parsedRows = [];

    const dataRows = data.slice(headerRowIndex + 1);

    for (const row of dataRows) {
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
      const gtinVal = gtinColIndex > -1 ? String(row[gtinColIndex] || "").trim() : "";
      const qtyVal = qtyColIndex > -1 ? parseInt(row[qtyColIndex]) : 1;
      
      let transactionDateTime;
      if (typeof dateVal === 'number') {
        transactionDateTime = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
      } else {
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
        return { success: false, error: "Database insert error." };
    }

    return { success: true, added, skipped };
    
  } catch (error) {
    console.error("Upload error:", error);
    return { success: false, error: error.message };
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
   // Fetch all claims for that merchant so the client can perform crosschecks natively
   return await prisma.settlementClaim.findMany({
       where: { merchantName }
   });
}

export async function getMerchants() {
    const records = await prisma.settlementClaim.findMany({
        distinct: ['merchantName'],
        select: { merchantName: true }
    });
    return records.map(c => c.merchantName);
}
