# WFS Claim Filing App — Changes Brief
**For AI Agent Implementation**

---

## Project Stack
- Next.js 16.2.2 App Router, `"use client"` components
- React 19, Tailwind CSS v4, Prisma + PostgreSQL
- Key files: `src/app/page.js` (all UI/logic), `src/actions/upload.js` (server actions), `src/lib/parser.js` (audit file parsing), `prisma/schema.prisma`

---

## CHANGE 1 — Fix SSR 500 Error (Critical)

**File:** `src/app/page.js`

**Problem:** `import * as xlsx from "xlsx"` at the top of the file causes a 500 on server-side render because Next.js App Router pre-renders client components on the server, and xlsx has browser/Node conflicts at import time.

**Fix — Remove** this line from the top-level imports:
```js
import * as xlsx from "xlsx";
```

**Fix — Change** `generateDisputeXlsx` from sync to async with dynamic import:

Find the function (currently starts with `const generateDisputeXlsx = (claim) => {`) and replace with:

```js
const generateDisputeXlsx = async (claim) => {
  const xlsx = await import("xlsx");
  const formatDate = (d) => {
    if (!d) return "";
    if (typeof d === "number") return new Date((d - 25569) * 86400 * 1000).toLocaleDateString("en-US");
    return String(d);
  };
  const headers = ["Inbound Order ID", "PO Number", "GTIN", "SKU", "Expected Units", "Received Units", "PO Delivered Date"];
  const dataRow = [
    claim.inboundId || "",
    claim.poNumber || "",
    claim.gtin || "",
    claim.sku || "",
    claim.expectedUnits != null ? claim.expectedUnits : "",
    claim.receivedUnits != null ? claim.receivedUnits : "",
    formatDate(claim.poDeliveredDate),
  ];
  const ws = xlsx.utils.aoa_to_sheet([headers, dataRow]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Packing List");
  const buf = xlsx.write(wb, { bookType: "xlsx", type: "buffer" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Dispute_${claim.inboundId || claim.poNumber || "claim"}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("Dispute template downloaded");
};
```

---

## CHANGE 2 — Prisma Schema (CaseStatus table)

**File:** `prisma/schema.prisma`

**Find** the CaseStatus model and **replace** with:

```prisma
model CaseStatus {
  id             String   @id @default(uuid())
  gtin           String
  caseId         String   @unique
  status         String   // "Declined" | "Pending" | "For auto-RMS"
  merchantName   String?  // normalized: special chars stripped, uppercased
  inboundOrderId String?
  shipmentId     String?
  createdAt      DateTime @default(now())
}
```

**Also create** a new migration file at:
`prisma/migrations/20260411000000_case_status_merchant_fields/migration.sql`

```sql
ALTER TABLE "CaseStatus" ADD COLUMN "merchantName" TEXT;
ALTER TABLE "CaseStatus" ADD COLUMN "inboundOrderId" TEXT;
ALTER TABLE "CaseStatus" ADD COLUMN "shipmentId" TEXT;
```

---

## CHANGE 3 — Server Actions (`src/actions/upload.js`)

### 3a. Replace `fetchCaseStatuses`

```js
export async function fetchCaseStatuses(gtins, merchantName) {
  // gtins: normalized GTINs (leading zeros stripped)
  // merchantName: optional — scopes results per client
  if (!gtins || gtins.length === 0) return [];
  const normName = merchantName
    ? String(merchantName).trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").toUpperCase()
    : null;
  return await prisma.caseStatus.findMany({
    where: {
      gtin: { in: gtins },
      ...(normName ? { OR: [{ merchantName: normName }, { merchantName: null }] } : {}),
    },
    select: { gtin: true, caseId: true, status: true, inboundOrderId: true, shipmentId: true }
  });
}
```

### 3b. Replace `importCaseStatuses`

```js
export async function importCaseStatuses(rows) {
  // rows: [{ gtin, caseId, status, merchantName?, inboundOrderId?, shipmentId? }]
  if (!rows.length) return { added: 0, skipped: 0 };
  let added = 0, skipped = 0;
  for (const row of rows) {
    try {
      await prisma.caseStatus.upsert({
        where: { caseId: row.caseId },
        update: {
          gtin: row.gtin,
          status: row.status,
          merchantName: row.merchantName ?? null,
          inboundOrderId: row.inboundOrderId ?? null,
          shipmentId: row.shipmentId ?? null,
        },
        create: {
          gtin: row.gtin,
          caseId: row.caseId,
          status: row.status,
          merchantName: row.merchantName ?? null,
          inboundOrderId: row.inboundOrderId ?? null,
          shipmentId: row.shipmentId ?? null,
        },
      });
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
}
```

---

## CHANGE 4 — Case Status Import Handler (`src/app/page.js`)

**Context:** The import file is an "All Client RMS Report" CSV/XLSX with these key columns:
- Column **N** = `Case Status` — values: `"In-Progress"` or `"resolved"`
- Column **O** = `Reimbursement Status` — values: `"Declined"`, `"For auto-RMS"`, `"approved"`, or blank

**Two-column decision logic:**
- N = `In-Progress` → store as **Pending**
- N = `resolved` + O = `Declined` → store as **Declined**
- N = `resolved` + O contains `auto-rms` → store as **For auto-RMS**
- N = `resolved` + O = `approved` or blank → **skip** (not needed)

**Add** the `normalizeName` helper just before the handler:
```js
const normalizeName = (s) => String(s || '').trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').toUpperCase();
```

**Replace** `handleCaseStatusImport` entirely with:

```js
const handleCaseStatusImport = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  setIsLoading(true);
  try {
    const data = await parseFile(file);
    if (!data || data.length < 2) { toast.error("Empty or invalid file."); setIsLoading(false); return; }

    const headers = data[0].map(h => String(h || '').trim().toLowerCase());
    const col = (names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));

    const clientNameIdx   = col(['client name', 'client']);
    const caseIdIdx       = col(['case id', 'case_id', 'case #', 'case number']);
    const gtinIdx         = col(['gtin', 'partner gtin']);
    const inboundOrderIdx = col(['inbound order id', 'inbound order']);
    const shipmentIdIdx   = col(['shipment id', 'shipment_id']);
    const caseStatusIdx   = col(['case status']);        // column N
    const reimbStatusIdx  = col(['reimbursement status']); // column O

    if (caseIdIdx === -1)     { toast.error("'Case ID' column not found.");     setIsLoading(false); return; }
    if (gtinIdx === -1)       { toast.error("'GTIN' column not found.");        setIsLoading(false); return; }
    if (caseStatusIdx === -1) { toast.error("'Case Status' column not found."); setIsLoading(false); return; }

    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row.length) continue;

      const caseId = String(row[caseIdIdx] || '').trim();
      const gtin   = String(row[gtinIdx]   || '').trim().replace(/^0+/, '');
      if (!caseId || !gtin) continue;

      const caseStatus = String(row[caseStatusIdx] || '').trim().toLowerCase();
      const reimb      = reimbStatusIdx > -1 ? String(row[reimbStatusIdx] || '').trim().toLowerCase() : '';

      let status = null;
      if (caseStatus.includes('in-progress') || caseStatus.includes('in progress')) {
        status = 'Pending';
      } else if (caseStatus === 'resolved') {
        if (reimb.includes('declined'))                                     status = 'Declined';
        else if (reimb.includes('auto-rms') || reimb.includes('auto rms')) status = 'For auto-RMS';
      }
      if (!status) continue;

      rows.push({
        caseId,
        gtin,
        status,
        merchantName:   clientNameIdx   > -1 ? normalizeName(String(row[clientNameIdx]   || '')) || null : null,
        inboundOrderId: inboundOrderIdx > -1 ? String(row[inboundOrderIdx] || '').trim() || null : null,
        shipmentId:     shipmentIdIdx   > -1 ? String(row[shipmentIdIdx]   || '').trim() || null : null,
      });
    }

    if (!rows.length) { toast.error("No actionable rows (In-Progress, Declined, or For auto-RMS)."); setIsLoading(false); return; }
    const result = await importCaseStatuses(rows);
    toast.success(`Case statuses: ${result.added} imported, ${result.skipped} skipped`);
  } catch (err) {
    console.error(err);
    toast.error("Failed to import case statuses.");
  } finally { setIsLoading(false); }
};
```

---

## CHANGE 5 — Use Filename as Client Name (`src/app/page.js`)

### 5a. Add toggle to preferences defaults

Find the `toggles` useState initializer. Its defaults object currently looks like:
```js
const defaults = { hideReimbursed: true, markInvestigated: true, showDate: false };
```
Add `useFilenameAsClient: false` to it:
```js
const defaults = { hideReimbursed: true, markInvestigated: true, showDate: false, useFilenameAsClient: false };
```

### 5b. Replace `detectClientName`

```js
const detectClientName = (file) => {
  const base = file.name.replace(/\.(csv|xlsx)$/i, "").trim();
  if (toggles.useFilenameAsClient) return base;
  // Try "Master Data - ClientName" pattern first
  const match = base.match(/Master Data - (.+)$/i);
  const raw = match ? match[1].trim() : base;
  // Strip leading/trailing special chars (e.g. _ALMAR SALES CO INC_ → ALMAR SALES CO INC)
  return raw.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim() || raw;
};
```

### 5c. Add "filename" quick-fill button in queue item JSX

In the upload queue row (inside the `pending` item section, after the `<input>` for new client name), add:

```jsx
<button
  className="text-[10px] text-blue-500 hover:text-blue-700 shrink-0 whitespace-nowrap"
  title="Use filename as client name"
  onClick={() => updateQueueItemClient(
    item.id,
    item.file.name.replace(/\.(csv|xlsx)$/i, '').replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim()
  )}
>filename</button>
```

### 5d. Add toggle row in Preferences tab

In the Settings → Preferences tab, find the array passed to `.map()` that renders the toggle rows (it has `hideReimbursed`, `markInvestigated`, `showDate`). Add this entry:

```js
{ key: "useFilenameAsClient", label: "Use Filename as Client Name", desc: "Skip pattern detection — always use the raw filename (without extension) as the client name on upload." },
```

---

## CHANGE 6 — Crosscheck: Pass merchantName + Better Case Status Matching (`src/app/page.js`)

Inside `handleCrosscheck`, find where `fetchCaseStatuses` is called. Currently:
```js
caseStatusList = await fetchCaseStatuses(allGtins);
```

**Replace** that entire block (the call + the Map-based lookup) with:

```js
// Scope case statuses to the selected client (null = all clients mode)
const csFilter = selectedMerchant === "all" ? null : selectedMerchant;
caseStatusList = await fetchCaseStatuses(allGtins, csFilter);
```

Then in the `claims.map(claim => {...})` block, find:
```js
const caseStatusMatches = caseStatusByGtin.get(normGtin) || [];
```
And **replace** with (also remove the `caseStatusByGtin` Map that's no longer needed):
```js
const caseStatusMatches = caseStatusList.filter(cs => {
  if (cs.gtin && normGtin && cs.gtin === normGtin) return true;
  if (cs.inboundOrderId && claim.inboundId && cs.inboundOrderId === claim.inboundId) return true;
  if (cs.shipmentId && claim.poNumber && cs.shipmentId === claim.poNumber) return true;
  return false;
});
```

---

## CHANGE 7 — "For auto-RMS" Badge (`src/app/page.js`)

There are **two places** that render the `caseStatusMatches` status pill — one in the **table row** (Col 4: Status) and one in the **side panel header**. Both currently look like:

```jsx
{claim.caseStatusMatches?.length > 0 && (() => {
  const declined = claim.caseStatusMatches.find(c => c.status === "Declined");
  const cs = declined || claim.caseStatusMatches[0];
  return cs.status === "Declined"
    ? <span className="...orange...">Declined</span>
    : <span className="...amber...">Pending</span>;
})()}
```

**Replace both instances** with:

```jsx
{claim.caseStatusMatches?.length > 0 && (() => {
  const declined = claim.caseStatusMatches.find(c => c.status === "Declined");
  const autoRms  = claim.caseStatusMatches.find(c => c.status === "For auto-RMS");
  const cs = declined || autoRms || claim.caseStatusMatches[0];
  if (cs.status === "Declined")
    return <span className="inline-flex items-center bg-orange-50 text-orange-700 border border-orange-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">Declined</span>;
  if (cs.status === "For auto-RMS")
    return <span className="inline-flex items-center bg-violet-50 text-violet-700 border border-violet-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">For auto-RMS</span>;
  return <span className="inline-flex items-center bg-amber-50 text-amber-700 border border-amber-100 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">Pending</span>;
})()}
```

Note: the side panel version uses `selectedClaim.caseStatusMatches` instead of `claim.caseStatusMatches` — same logic, different variable name.

---

## Settlement Upload Logic Summary (for context)

`processSettlementFile` in `src/actions/upload.js` handles two WFS export formats (CSV and XLSX) in one function:

1. **Header scan** — scans up to 20 rows to find the row containing `"transaction type"`, so files with metadata rows above the table still work
2. **GTIN precision** — reads with `cellText: true` so `.w` (display string) is available. Prefers `.w` over `.v` to avoid scientific notation truncation
3. **Row filter** — keeps only: `Refund` (inbound reason only), `LostInventory`, `DamageInWarehouse`, `InboundTransportationFee`
4. **Date parsing** — handles Excel serial numbers, US `M/D/YYYY` strings, and ISO strings
5. **Dedup** — `createMany({ skipDuplicates: true })` using DB unique constraint on `[wfsReferenceId, transactionDateTime, netPayable, merchantName]`

Queue items flow: `pending → uploading → done | error`. Errors show inline (hover tooltip), never a toast, so the user can fix the client name and retry that specific item.
