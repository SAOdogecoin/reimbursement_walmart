import * as xlsx from "xlsx";

function getColMap(data, headerStrings) {
    if(!data || data.length === 0) return null;
    
    let headerRowIndex = -1;
    let colMap = {};
    for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = data[i];
        if (!row) continue;
        const lowerRow = row.map(c => String(c).trim().toLowerCase());
        
        let matchCount = 0;
        for (const str of headerStrings) {
            if (lowerRow.some(r => r.includes(str.toLowerCase()))) matchCount++;
        }
        
        if (matchCount >= Math.min(3, headerStrings.length)) {
             headerRowIndex = i;
             lowerRow.forEach((hName, idx) => {
                 colMap[hName] = idx;
             });
             break;
        }
    }
    
    if (headerRowIndex === -1) return null;
    return { headerRowIndex, colMap, data: data.slice(headerRowIndex + 1) };
}

export async function parseFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = xlsx.read(arrayBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(sheet, { header: 1 });
}

export function findWarehouseClaims(data) {
    const claims = [];
    const parsed = getColMap(data, ['gtin', 'lost', 'found', 'removed', 'vendor (seller) sku']);
    if (!parsed) return claims;
    
    const { colMap, data: rows } = parsed;
    const mapKey = (names) => {
        for(let n of names) {
           const found = Object.keys(colMap).find(k => k.includes(n));
           if (found) return colMap[found];
        }
        return -1;
    };
    
    const gtinIdx = mapKey(['gtin']);
    const lostIdx = colMap['lost'] ?? -1;
    const foundIdx = colMap['found'] ?? -1;
    const remIdx = colMap['removed'] ?? -1;
    const skuIdx = mapKey(['vendor (seller) sku', 'sku']);
    
    const gtinDiscrepancies = new Map();
    
    rows.forEach(v => {
        const gtin = gtinIdx > -1 ? String(v[gtinIdx] || '').trim() : '';
        if (!gtin) return;
        if (!gtinDiscrepancies.has(gtin)) {
            gtinDiscrepancies.set(gtin, { gtin, sku: skuIdx > -1 ? String(v[skuIdx]||'') : '', lost: 0, found: 0, removed: 0});
        }
        const state = gtinDiscrepancies.get(gtin);
        state.lost += parseInt(v[lostIdx] || 0) || 0;
        state.found += parseInt(v[foundIdx] || 0) || 0;
        state.removed += parseInt(v[remIdx] || 0) || 0;
        if(skuIdx > -1 && v[skuIdx]) state.sku = v[skuIdx];
    });
    
    for (const [gtin, d] of gtinDiscrepancies.entries()) {
        const netLoss = Math.abs(d.lost) - d.found;
        const damagedCount = Math.abs(d.removed);
        const baseClaim = { gtin:d.gtin, sku:d.sku, isCollapsed:true, isInvestigated:false };
        
        if (netLoss > 0) claims.push({...baseClaim, claimType:'Lost in Warehouse', lostUnits:Math.abs(d.lost), foundUnits:d.found, shortage:netLoss});
        if (damagedCount > 0) claims.push({...baseClaim, claimType:'Damaged in Warehouse', damagedUnits:damagedCount, shortage:damagedCount});
    }
    return claims;
}

export function findInboundClaims(data) {
    const claims = [];
    // Only requiring 2 of these:
    const parsed = getColMap(data, ['inbound order id', 'po delivered date']);
    if (!parsed) return claims;
    
    const { colMap, data: rows } = parsed;
    const mapKey = (names) => {
        for(let n of names) {
           const found = Object.keys(colMap).find(k => k === n);
           if (found !== undefined) return colMap[found];
        }
        return -1;
    };
    
    const idIdx = mapKey(['inbound order id']);
    const delIdx = mapKey(['po delivered date']);
    const expIdx = mapKey(['expected units']);
    const rcvIdx = mapKey(['received units']);
    const dmgIdx = mapKey(['damaged units']);
    const gtinIdx = mapKey(['gtin', 'partner gtin']);
    const crIdx = mapKey(['po create date']);
    const skuIdx = mapKey(['sku', 'vendor (seller) sku']);
    const poIdx = mapKey(['po number', 'po']);
    
    rows.forEach(v => {
        const gtin = gtinIdx > -1 ? String(v[gtinIdx] || '').trim() : '';
        if (!gtin) return;
        
        const exp = parseInt(v[expIdx] || 0) || 0;
        const rcv = parseInt(v[rcvIdx] || 0) || 0;
        const dmg = parseInt(v[dmgIdx] || 0) || 0;
        const delDate = delIdx > -1 ? v[delIdx] : null;
        const crDate = crIdx > -1 ? v[crIdx] : null;
        const id = idIdx > -1 ? String(v[idIdx]||'') : '';
        const po = poIdx > -1 ? String(v[poIdx]||'') : '';
        
        const base = {
           gtin, inboundId: id, sku: skuIdx > -1 ? v[skuIdx] : '',
           poNumber: po, poCreateDate: crDate, poDeliveredDate: delDate,
           expectedUnits: exp, receivedUnits: rcv, damagedUnits: dmg,
           isCollapsed: true, isInvestigated: false
        };
        
        if (delDate && id && !id.toUpperCase().includes('MTR')) {
             let jsDelDate = typeof delDate === 'number' ? new Date((delDate - 25569) * 86400 * 1000) : new Date(delDate);
             const days = Math.floor((new Date() - jsDelDate) / 864e5);
             if (days >= 10 && days <= 50) {
                 if (exp > rcv) claims.push({...base, claimType: 'Inbound Discrepancy', shortage: exp - rcv});
                 if (dmg > 0) claims.push({...base, claimType: 'Damaged Inbound', shortage: dmg});
             }
        }
        
        if (crDate && id && id.toUpperCase().includes('MTR')) {
             let jsCrDate = typeof crDate === 'number' ? new Date((crDate - 25569) * 86400 * 1000) : new Date(crDate);
             if (Math.floor((new Date() - jsCrDate) / 864e5) >= 30 && exp > rcv) {
                 claims.push({...base, claimType: 'MTR Shortage', shortage: exp - rcv});
             }
        }
    });
    return claims;
}

export function findUnusedLabelClaims(data) {
    const claims = [];
    const parsed = getColMap(data, ['po status', 'inbound transportation charge']);
    if (!parsed) return claims;
    
    const { colMap, data: rows } = parsed;
    
    const poIdx = Object.keys(colMap).find(k => k.includes('po number')) ? colMap[Object.keys(colMap).find(k => k.includes('po number'))] : -1;
    const statIdx = Object.keys(colMap).find(k => k.includes('po status')) ? colMap[Object.keys(colMap).find(k => k.includes('po status'))] : -1;
    const feeIdx = Object.keys(colMap).find(k => k.includes('transportation charge')) ? colMap[Object.keys(colMap).find(k => k.includes('transportation charge'))] : -1;
    
    rows.forEach(v => {
        const stat = statIdx > -1 ? String(v[statIdx]||'') : '';
        const feeStr = feeIdx > -1 ? String(v[feeIdx]||'') : '0';
        const po = poIdx > -1 ? String(v[poIdx]||'') : '';
        
        const fee = parseFloat(feeStr.replace(/[^0-9.-]+/g,""));
        if (stat === 'CANCELLED_GDM' && fee > 0) {
            claims.push({ poNumber: po, claimType: 'Unused Label', isCollapsed: true, isInvestigated: false, inboundFee: fee, shortage: fee });
        }
    });
    
    return claims;
}
