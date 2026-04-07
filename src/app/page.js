"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { FileSpreadsheet, FolderOpen, FileText, SlidersHorizontal, RefreshCcw, Download, UploadCloud, Moon, Sun, Table2, Info, ChevronRight, ChevronDown, ClipboardPaste, ExternalLink, Database, SlidersVertical, NotebookPen, Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { processSettlementFile, getMerchants, fetchCrosscheckData, fetchCaseStatuses } from "@/actions/upload";
import { parseFile, findInboundClaims, findWarehouseClaims, findUnusedLabelClaims } from "@/lib/parser";

export default function Dashboard() {
  const { theme, setTheme } = useTheme();

  // Audit State
  const [inboundFiles, setInboundFiles] = useState([]);
  const [reconFiles, setReconFiles] = useState([]);
  const [generatedClaims, setGeneratedClaims] = useState([]);
  
  // Settings & DB State
  const [merchants, setMerchants] = useState([]);
  const [selectedMerchant, setSelectedMerchant] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("database");
  const [uploadMerchant, setUploadMerchant] = useState("");
  const [newMerchantName, setNewMerchantName] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [pendingFile, setPendingFile] = useState(null);
  const [partnerIdMap, setPartnerIdMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem("partnerIdMap") || "{}"); } catch { return {}; }
  });
  
  // Claim UI State
  const [expandedClaims, setExpandedClaims] = useState(new Set());
  const [investigatedClaims, setInvestigatedClaims] = useState(new Set());

  const toggleExpand = (idx, e) => {
    e?.stopPropagation();
    const next = new Set(expandedClaims);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setExpandedClaims(next);
  };

  const toggleInvestigated = (idx, e) => {
    e?.stopPropagation();
    const next = new Set(investigatedClaims);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setInvestigatedClaims(next);
  };
  
  // File References
  const multiFileInputRef = useRef(null);
  const settlementFileInputRef = useRef(null);

  // Filters State
  const [filters, setFilters] = useState({
    "Inbound Discrepancy": true,
    "Damaged Inbound": true,
    "MTR Shortage": true,
    "Lost in Warehouse": true,
    "Damaged in Warehouse": true,
    "Unused Label": true,
  });

  const [toggles, setToggles] = useState({
    hideReimbursed: true,
    markInvestigated: true,
    showDate: false
  });

  useEffect(() => {
    getMerchants().then(setMerchants).catch(console.error);
  }, []);

  const handleAuditFiles = async (files) => {
    setIsLoading(true);
    toast("Reading files...");
    let claimsAccumulator = [];
    let newInbound = [...inboundFiles];
    let newRecon = [...reconFiles];

    for (const file of Array.from(files)) {
      const name = file.name.toLowerCase();
      try {
        const data = await parseFile(file);
        if (name.includes("inboundreceipt")) {
            newInbound.push(file.name);
            claimsAccumulator.push(...findInboundClaims(data));
            claimsAccumulator.push(...findUnusedLabelClaims(data));
        } else if (name.includes("reconciliation")) {
            newRecon.push(file.name);
            claimsAccumulator.push(...findWarehouseClaims(data));
        }
      } catch (err) {
        console.error(err);
        toast.error(`Failed to parse ${file.name}`);
      }
    }

    setInboundFiles(newInbound);
    setReconFiles(newRecon);
    
    // Deduplicate
    const uniqueClaims = new Map();
    [...generatedClaims, ...claimsAccumulator].forEach(claim => {
       const key = `${claim.claimType}|${claim.inboundId||claim.poNumber||claim.gtin}`;
       if (!uniqueClaims.has(key)) uniqueClaims.set(key, claim);
    });

    setGeneratedClaims(Array.from(uniqueClaims.values()));
    setIsLoading(false);
    toast.success("Audit updated.");
  };

  const handleCrosscheck = async () => {
    if (!selectedMerchant) return toast.error("Select a merchant first.");
    if (generatedClaims.length === 0) return toast.error("Upload reports first.");
    setIsLoading(true);

    try {
      const historicalSettlements = await fetchCrosscheckData(selectedMerchant);

      // Collect all unique normalized GTINs from claims to fetch case statuses
      const allGtins = [...new Set(generatedClaims.map(c => (c.gtin || '').replace(/^0+/, '')).filter(Boolean))];
      const caseStatusList = await fetchCaseStatuses(allGtins);
      const caseStatusByGtin = new Map();
      caseStatusList.forEach(cs => {
        if (!caseStatusByGtin.has(cs.gtin)) caseStatusByGtin.set(cs.gtin, []);
        caseStatusByGtin.get(cs.gtin).push(cs);
      });

      const newClaims = generatedClaims.map(claim => {
         const normGtin = (claim.gtin || '').replace(/^0+/, '');
         const po = claim.poNumber;

         const matches = historicalSettlements.filter(s => {
             const sGtin = (s.partnerGtin || '').replace(/^0+/, '');
             const sPo = s.walmartPoNumber;
             const isRefund = s.transactionType === "Refund";

             if (claim.claimType === "Inbound Discrepancy" || claim.claimType === "Damaged Inbound" || claim.claimType === "MTR Shortage") {
                 return sPo === po && sGtin === normGtin && isRefund && s.reasonCode.toLowerCase().includes("inbound");
             }
             if (claim.claimType === "Lost in Warehouse") return sGtin === normGtin && s.transactionType === "LostInventory";
             if (claim.claimType === "Damaged in Warehouse") return sGtin === normGtin && s.transactionType === "DamageInWarehouse";
             if (claim.claimType === "Unused Label") return sPo === po && s.transactionType === "InboundTransportationFee";
             return false;
         });

         const caseStatusMatches = caseStatusByGtin.get(normGtin) || [];

         return { ...claim, reimbursementMatches: matches, caseStatusMatches };
      });

      setGeneratedClaims(newClaims);
      toast.success(`Crosscheck complete for ${selectedMerchant}`);
    } catch (err) {
      console.error(err);
      toast.error("Crosscheck failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSettlementFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);

    // 1. Try to extract merchant name from filename pattern:
    //    "WFS Claim Assistant - Master Data - CLIENT_NAME.csv/.xlsx"
    const baseName = file.name.replace(/\.(csv|xlsx)$/i, "");
    const filenameMatch = baseName.match(/Master Data - (.+)$/);
    if (filenameMatch) {
      const clientName = filenameMatch[1].trim();
      if (merchants.includes(clientName)) {
        setUploadMerchant(clientName);
      } else {
        setUploadMerchant("__new__");
        setNewMerchantName(clientName);
      }
      toast.success(`Auto-detected from filename: ${clientName}`);
      return;
    }

    // 2. Fallback: auto-detect via Partner ID column in CSV
    if (file.name.endsWith(".csv")) {
      try {
        const text = await file.text();
        const lines = text.split(/\r?\n/);
        const headers = lines[0].split(",").map(h => h.toLowerCase().replace(/"/g, "").trim());
        const pidCol = headers.findIndex(h => h === "partner id");
        if (pidCol > -1) {
          for (let i = 1; i < Math.min(lines.length, 5); i++) {
            const cols = lines[i].split(",");
            const pid = (cols[pidCol] || "").replace(/"/g, "").trim();
            if (pid && partnerIdMap[pid]) {
              setUploadMerchant(partnerIdMap[pid]);
              toast.success(`Auto-detected from Partner ID: ${partnerIdMap[pid]}`);
              break;
            }
          }
        }
      } catch {}
    }
  };

  const handleSettlementUpload = async () => {
    if (!pendingFile) return toast.error("Choose a file first.");
    const merchant = uploadMerchant === "__new__" ? newMerchantName.trim() : uploadMerchant;
    if (!merchant) return toast.error("Select or enter a merchant name.");
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", pendingFile);
      formData.append("merchantName", merchant);
      const result = await processSettlementFile(formData);
      if (result.error) toast.error(result.error);
      else {
        toast.success(`Added ${result.added} | Skipped ${result.skipped} duplicates`);
        getMerchants().then(setMerchants);
        setPendingFile(null);
      }
    } catch (err) {
      toast.error("Upload failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const savePartnerIdMap = (map) => {
    setPartnerIdMap(map);
    localStorage.setItem("partnerIdMap", JSON.stringify(map));
  };

  const openAllGtins = () => {
    const gtins = [...new Set(activeClaims.map(c => c.gtin).filter(Boolean))];
    if (!gtins.length) return toast.error("No GTINs in filtered claims.");
    if (gtins.length > 10) toast(`Opening first 10 of ${gtins.length} GTINs`);
    gtins.slice(0, 10).forEach(g => window.open(`https://www.walmart.com/search?q=${g}`, "_blank"));
  };

  const openAllPos = () => {
    const pos = [...new Set(activeClaims.map(c => c.poNumber).filter(Boolean))];
    if (!pos.length) return toast.error("No PO numbers in filtered claims.");
    navigator.clipboard.writeText(pos.join("\n"));
    toast.success(`${pos.length} PO numbers copied to clipboard`);
  };

  const copyClaim = (claim) => {
    const parts = [
      claim.claimType,
      claim.poNumber ? `PO: ${claim.poNumber}` : null,
      claim.gtin ? `GTIN: ${claim.gtin}` : null,
      claim.inboundId ? `Inbound: ${claim.inboundId}` : null,
    ].filter(Boolean);
    navigator.clipboard.writeText(parts.join(" | "));
    toast.success("Copied");
  };

  const copyClaimDetails = (claim) => {
    const lines = [
      `Claim Type: ${claim.claimType}`,
      claim.poNumber && `PO Number: ${claim.poNumber}`,
      claim.gtin && `GTIN: ${claim.gtin}`,
      claim.sku && `SKU: ${claim.sku}`,
      claim.inboundId && `Inbound ID: ${claim.inboundId}`,
      `Shortage / Units: ${claim.shortage || claim.damagedUnits || 0}`,
      claim.expectedUnits != null && `Expected: ${claim.expectedUnits}`,
      claim.receivedUnits != null && `Received: ${claim.receivedUnits}`,
      claim.reimbursementMatches?.length > 0 && `Reimbursed Qty: ${claim.reimbursementMatches.reduce((a, m) => a + (m.quantity || 1), 0)}`,
    ].filter(Boolean).join("\n");
    navigator.clipboard.writeText(lines);
    toast.success("Claim details copied to clipboard");
  };

  const activeClaims = generatedClaims.filter(c => {
     if (!filters[c.claimType]) return false;
     const term = searchQuery.toLowerCase();
     if (term && !((c.gtin||'').toLowerCase().includes(term) || (c.poNumber||'').toLowerCase().includes(term) || (c.inboundId||'').toLowerCase().includes(term))) return false;
     
     if (toggles.hideReimbursed && c.reimbursementMatches?.length > 0) {
        const totalReimbursed = c.reimbursementMatches.reduce((acc, m) => acc + (m.quantity || 1), 0);
        if (totalReimbursed >= (c.shortage || c.damagedUnits || 0)) return false;
     }
     return true;
  });

  const getCount = (type) => generatedClaims.filter(c => c.claimType === type).length;

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans text-sm">
      
      {/* Sidebar */}
      <aside className="w-[400px] border-r p-6 flex flex-col gap-6 overflow-y-auto shrink-0 bg-muted/20">
        <div className="flex justify-between items-center">
            <h1 className="text-3xl font-extrabold text-blue-600 dark:text-blue-500 tracking-tight">WFS Assistant</h1>
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogTrigger asChild>
                    <Button variant="outline" size="icon" className="rounded-xl"><SlidersHorizontal size={16} /></Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
                    <div className="flex h-[560px]">
                        {/* Sidebar */}
                        <nav className="w-48 border-r bg-muted/30 flex flex-col p-3 gap-1 shrink-0">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-2">Settings</p>
                            {[
                                { id: "database", label: "Database", icon: Database },
                                { id: "preferences", label: "Preferences", icon: SlidersVertical },
                                { id: "notes", label: "Notes", icon: NotebookPen },
                                { id: "appearance", label: "Appearance", icon: Palette },
                            ].map(({ id, label, icon: Icon }) => (
                                <button
                                    key={id}
                                    onClick={() => setSettingsTab(id)}
                                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left w-full ${settingsTab === id ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
                                >
                                    <Icon size={15} />
                                    {label}
                                </button>
                            ))}
                        </nav>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6">

                            {/* DATABASE TAB */}
                            {settingsTab === "database" && (
                                <div className="space-y-5">
                                    <div>
                                        <h2 className="font-semibold text-base mb-1">Update Settlement Master Sheet</h2>
                                        <p className="text-xs text-muted-foreground mb-4">Files named <span className="font-mono bg-muted px-1 rounded">WFS Claim Assistant - Master Data - CLIENT_NAME</span> will auto-detect the client.</p>
                                        <div className="space-y-3">
                                            <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => settlementFileInputRef.current?.click()}>
                                                <Table2 className="mr-2 h-4 w-4"/>{pendingFile ? pendingFile.name : "Choose Settlement File"}
                                            </Button>
                                            <input type="file" ref={settlementFileInputRef} className="hidden" accept=".csv,.xlsx" onChange={handleSettlementFileSelect} />
                                            <div>
                                                <Label className="text-xs text-muted-foreground mb-1 block">Target Merchant</Label>
                                                <Select value={uploadMerchant} onValueChange={setUploadMerchant}>
                                                    <SelectTrigger className="text-sm"><SelectValue placeholder="Select a merchant..." /></SelectTrigger>
                                                    <SelectContent>
                                                        {merchants.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                                                        <SelectItem value="__new__">+ New Merchant...</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            {uploadMerchant === "__new__" && (
                                                <Input placeholder="Enter merchant name" value={newMerchantName} onChange={e => setNewMerchantName(e.target.value)} className="text-sm" />
                                            )}
                                            <div className="flex items-center gap-2">
                                                <Checkbox checked={skipDuplicates} onCheckedChange={setSkipDuplicates} id="skip-dup" />
                                                <Label htmlFor="skip-dup" className="text-xs cursor-pointer">Skip duplicate check (faster)</Label>
                                            </div>
                                            <Button size="sm" className="w-full" onClick={handleSettlementUpload} disabled={isLoading || !pendingFile}>
                                                <UploadCloud className="mr-2 h-4 w-4"/>Upload & Append
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="border-t pt-5">
                                        <h3 className="font-semibold text-sm mb-1">Partner ID Mapping</h3>
                                        <p className="text-xs text-muted-foreground mb-3">Maps Partner IDs in settlement files to merchant names for auto-detection fallback.</p>
                                        <div className="space-y-1.5 max-h-36 overflow-y-auto border rounded-lg p-2 mb-3">
                                            {Object.keys(partnerIdMap).length === 0 && (
                                                <p className="text-xs text-muted-foreground text-center py-2">No mappings yet</p>
                                            )}
                                            {Object.entries(partnerIdMap).map(([pid, name]) => (
                                                <div key={pid} className="flex items-center gap-2 text-xs px-1">
                                                    <span className="truncate flex-1 font-medium">{name}</span>
                                                    <span className="font-mono text-muted-foreground shrink-0">{pid}</span>
                                                    <button className="text-muted-foreground hover:text-destructive shrink-0 ml-1" onClick={() => { const m = {...partnerIdMap}; delete m[pid]; savePartnerIdMap(m); }}>×</button>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="flex gap-2">
                                            <Input id="new-pid-name" placeholder="Merchant name" className="text-xs h-8" />
                                            <Input id="new-pid-id" placeholder="Partner ID" className="text-xs h-8 w-36 font-mono" />
                                            <Button size="sm" variant="outline" className="h-8 px-3 text-xs shrink-0" onClick={() => {
                                                const name = document.getElementById("new-pid-name").value.trim();
                                                const pid = document.getElementById("new-pid-id").value.trim();
                                                if (name && pid) { savePartnerIdMap({...partnerIdMap, [pid]: name}); document.getElementById("new-pid-name").value = ""; document.getElementById("new-pid-id").value = ""; }
                                            }}>Add</Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* PREFERENCES TAB */}
                            {settingsTab === "preferences" && (
                                <div className="space-y-0">
                                    <h2 className="font-semibold text-base mb-4">Preferences</h2>
                                    {[
                                        { key: "hideReimbursed", label: "Hide Fully Reimbursed Claims", desc: "Claims where reimbursed qty ≥ shortage are hidden from the list." },
                                        { key: "markInvestigated", label: "Mark as Investigated on Export", desc: "Checked claims are marked investigated when exporting." },
                                        { key: "showDate", label: "Show Report Date Range", desc: "Display the date range of the uploaded reports." },
                                    ].map(({ key, label, desc }) => (
                                        <div key={key} className="flex items-start justify-between py-4 border-b last:border-b-0 gap-4">
                                            <div>
                                                <p className="text-sm font-medium">{label}</p>
                                                <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                                            </div>
                                            <Switch checked={toggles[key]} onCheckedChange={(v) => setToggles({...toggles, [key]: v})} className="shrink-0 mt-0.5" />
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* NOTES TAB */}
                            {settingsTab === "notes" && (
                                <div className="space-y-5">
                                    <div>
                                        <h2 className="font-semibold text-base mb-1">Note Management</h2>
                                        <p className="text-xs text-muted-foreground mb-4">Enable note editing per claim category.</p>
                                        <div className="grid grid-cols-2 gap-2">
                                            {["Inbound Discrepancy", "Damaged Inbound", "MTR Shortage", "Lost in Warehouse", "Damaged in Warehouse", "Unused Label"].map(cat => (
                                                <div key={cat} className="flex justify-between items-center bg-muted/30 p-3 rounded-lg border">
                                                    <span className="text-[11px] font-medium leading-tight pr-2">{cat}</span>
                                                    <Switch className="scale-75 origin-right shrink-0" />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="border-t pt-5">
                                        <h3 className="font-semibold text-sm mb-1">Sync Notes</h3>
                                        <p className="text-xs text-muted-foreground mb-3">Import or export all notes as a JSON file.</p>
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" className="h-8 text-xs"><Download className="mr-1.5 h-3.5 w-3.5"/>Export Notes</Button>
                                            <Button variant="outline" size="sm" className="h-8 text-xs"><UploadCloud className="mr-1.5 h-3.5 w-3.5"/>Import Notes</Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* APPEARANCE TAB */}
                            {settingsTab === "appearance" && (
                                <div className="space-y-5">
                                    <h2 className="font-semibold text-base mb-4">Appearance</h2>
                                    <div className="flex items-center justify-between py-4 border-b">
                                        <div>
                                            <p className="text-sm font-medium">Theme</p>
                                            <p className="text-xs text-muted-foreground mt-0.5">Switch between light and dark mode.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Sun size={15} className="text-muted-foreground" />
                                            <Switch checked={theme === "dark"} onCheckedChange={(v) => setTheme(v ? "dark" : "light")} />
                                            <Moon size={15} className="text-muted-foreground" />
                                        </div>
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>

        <Card className="p-6 border-dashed border-2 flex flex-col items-center justify-center text-center gap-4 bg-transparent cursor-pointer hover:bg-muted/50 transition" onClick={() => multiFileInputRef.current?.click()}>
            <FileSpreadsheet size={48} className="text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground font-medium">Drag & drop reports here, or select files to begin</p>
            <div className="flex gap-2 w-full">
                <Button variant="secondary" className="flex-1" onClick={(e) => { e.stopPropagation(); multiFileInputRef.current?.click(); }}><FolderOpen className="mr-2 h-4 w-4"/>Select Files</Button>
                <Button variant="outline" className="flex-1" onClick={(e) => { e.stopPropagation(); setGeneratedClaims([]); setInboundFiles([]); setReconFiles([]); }}><FileText className="mr-2 h-4 w-4"/>New Audit</Button>
                <input type="file" ref={multiFileInputRef} multiple className="hidden" accept=".csv,.xlsx" onChange={(e) => handleAuditFiles(e.target.files)} />
            </div>
            {(inboundFiles.length > 0 || reconFiles.length > 0) && (
                <div className="w-full text-left mt-2 space-y-2">
                    <div className="bg-background rounded-lg border p-3">
                        <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Inbound Receipts</Label>
                        {inboundFiles.map(f => <div key={f} className="text-sm pt-1 truncate">{f}</div>)}
                    </div>
                    <div className="bg-background rounded-lg border p-3">
                        <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Reconciliation</Label>
                        {reconFiles.map(f => <div key={f} className="text-sm pt-1 truncate">{f}</div>)}
                    </div>
                </div>
            )}
        </Card>

        <Card className="p-5 shadow-sm border">
            <h3 className="font-semibold text-sm mb-3">Select merchant to crosscheck</h3>
            <Select value={selectedMerchant} onValueChange={setSelectedMerchant}>
                <SelectTrigger><SelectValue placeholder="--- Select Database Target ---" /></SelectTrigger>
                <SelectContent>
                    {merchants.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
            </Select>
            <Button className="w-full mt-3" onClick={handleCrosscheck} disabled={isLoading}><RefreshCcw className="mr-2 h-4 w-4" />Crosscheck</Button>
        </Card>

        <Card className="p-5 shadow-sm border flex-1">
            <h3 className="font-semibold text-sm mb-3">Audit Filters</h3>
            <div className="flex flex-wrap gap-2 mb-4">
                {Object.keys(filters).map(cat => (
                    <Badge 
                        key={cat} 
                        variant={filters[cat] ? "default" : "outline"} 
                        className="cursor-pointer py-1.5 transition-all text-xs"
                        onClick={() => setFilters(prev => ({...prev, [cat]: !prev[cat]}))}
                    >
                        {cat} ({getCount(cat)})
                    </Badge>
                ))}
            </div>
            <Input placeholder="Search by GTIN, PO, Inbound ID..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-background" />
        </Card>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative w-full h-full">
        <header className="px-8 py-6 border-b bg-background z-10 sticky top-0 flex justify-between items-center w-full min-h-[85px]">
            <h2 className="text-2xl font-bold tracking-tight">Eligible Claims</h2>
            <div className="space-x-3">
                <Button variant="outline" size="sm" className="font-medium h-9" onClick={openAllPos}><ExternalLink className="mr-2 h-4 w-4"/>Open All Filtered POs</Button>
                <Button variant="outline" size="sm" className="font-medium h-9" onClick={openAllGtins}><ExternalLink className="mr-2 h-4 w-4"/>Open All Filtered GTINs</Button>
            </div>
        </header>
        
        <div className="p-8 flex-1 overflow-y-auto w-full max-w-[1400px]">
            {activeClaims.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground w-full">
                    <FileText size={64} className="opacity-20 mb-4" />
                    <h3 className="text-lg font-medium">No Claims Found</h3>
                    <p className="text-sm opacity-70">Use the panel on the left to upload your reports to begin.</p>
                </div>
            ) : (
                <div className="space-y-0 w-full rounded-xl overflow-hidden border">
                    {activeClaims.map((claim, idx) => {
                        const isExpanded = expandedClaims.has(idx);
                        const isInvestigated = investigatedClaims.has(idx);
                        
                        return (
                            <div key={idx} className={`w-full bg-card border-b last:border-b-0 transition-opacity ${isInvestigated ? 'opacity-60' : ''}`}>
                                {/* Row Header */}
                                <div className="p-4 flex items-center justify-between group hover:bg-muted/30 cursor-pointer" onClick={() => toggleExpand(idx)}>
                                    <div className="flex items-center gap-4 w-3/4">
                                        <div className="pt-0.5">
                                           <Checkbox checked={isInvestigated} onCheckedChange={(v) => toggleInvestigated(idx)} onClick={(e) => e.stopPropagation()} />
                                        </div>
                                        <button onClick={(e) => toggleExpand(idx, e)} className="text-muted-foreground hover:text-foreground">
                                            {isExpanded ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}
                                        </button>
                                        
                                        <div className="flex flex-col overflow-hidden w-full">
                                            <div className="flex items-center gap-2">
                                                <h4 className={`font-bold text-[14px] truncate ${isInvestigated ? 'line-through text-muted-foreground' : ''}`}>
                                                    {claim.claimType.includes('Warehouse') ? `GTIN: ${claim.gtin}` : claim.poNumber ? `PO: ${claim.poNumber}` : `Inbound: ${claim.inboundId}`}
                                                </h4>
                                                
                                                {/* Hidden buttons that show on hover just like the screenshot */}
                                                <div className="invisible group-hover:visible flex items-center gap-2 ml-2 transition-all opacity-0 group-hover:opacity-100 h-7" onClick={e => e.stopPropagation()}>
                                                    <Button variant="outline" className="h-full px-3 text-xs w-fit rounded-full bg-background font-medium hover:bg-muted" onClick={() => { const q = claim.gtin || claim.poNumber || claim.inboundId; if (q) window.open(`https://www.walmart.com/search?q=${q}`, "_blank"); }}>Open</Button>
                                                    <Button variant="outline" className="h-full px-3 text-xs w-fit rounded-full bg-background font-medium hover:bg-muted" onClick={() => copyClaim(claim)}>Copy</Button>
                                                </div>
                                            </div>
                                            <p className="text-[13px] text-muted-foreground mt-0.5 truncate">
                                                {claim.claimType === 'Lost in Warehouse' ? 'Net Loss' : claim.claimType === 'Damaged in Warehouse' ? 'Damaged' : 'Discrepancy'}: <span className="font-medium text-foreground">{claim.shortage || claim.damagedUnits || 0} units</span>
                                                {claim.gtin && !claim.claimType.includes('Warehouse') ? ` | GTIN: ${claim.gtin}` : ''}
                                            </p>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-2">
                                       {claim.reimbursementMatches?.length > 0 && (
                                            <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-[11px] rounded-full px-3">
                                                Reimbursed ({claim.reimbursementMatches.reduce((acc, m) => acc + (m.quantity || 1), 0)} Qty)
                                            </Badge>
                                        )}
                                        {claim.caseStatusMatches?.length > 0 && (() => {
                                            const declined = claim.caseStatusMatches.find(c => c.status === 'Declined');
                                            const cs = declined || claim.caseStatusMatches[0];
                                            return (
                                                <Badge className={`text-white font-semibold text-[11px] rounded-full px-3 ${cs.status === 'Declined' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-yellow-500 hover:bg-yellow-600'}`}>
                                                    Case {cs.status}
                                                </Badge>
                                            );
                                        })()}
                                    </div>
                                </div>
                                
                                {/* Expanded Content Details */}
                                {isExpanded && (
                                    <div className="px-14 py-6 bg-background border-t shadow-[inset_0_4px_10px_rgba(0,0,0,0.01)] cursor-default">
                                        
                                        <div className="mb-6">
                                            <h5 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground border-b pb-2 mb-4">Units & Values</h5>
                                            <div className="grid grid-cols-4 gap-x-8 gap-y-4">
                                                {claim.claimType === 'Lost in Warehouse' ? (
                                                   <>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Lost</p><p className="font-semibold text-[13px]">{claim.lostUnits||0}</p></div>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Found</p><p className="font-semibold text-[13px]">{claim.foundUnits||0}</p></div>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Net Loss</p><p className="font-semibold text-[13px]">{claim.shortage||0}</p></div>
                                                   </>
                                                ) : claim.claimType === 'Damaged in Warehouse' ? (
                                                    <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Damaged</p><p className="font-semibold text-[13px]">{claim.damagedUnits||0}</p></div>
                                                ) : (
                                                   <>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Expected</p><p className="font-semibold text-[13px]">{claim.expectedUnits||0}</p></div>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Received</p><p className="font-semibold text-[13px]">{claim.receivedUnits||0}</p></div>
                                                     <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Shortage</p><p className="font-semibold text-[13px]">{claim.shortage||0}</p></div>
                                                   </>
                                                )}
                                            </div>
                                        </div>

                                        <div className="mb-6">
                                            <h5 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground border-b pb-2 mb-4">Identifiers & Dates</h5>
                                            <div className="grid grid-cols-3 gap-x-8 gap-y-6">
                                                {claim.gtin && (
                                                    <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">GTIN</p><a href="#" className="font-semibold text-[13px] text-blue-500 hover:underline">{claim.gtin}</a></div>
                                                )}
                                                {claim.sku && (
                                                    <div className="col-span-2"><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">SKU</p><p className="font-semibold text-[13px] truncate">{claim.sku}</p></div>
                                                )}
                                                {claim.poNumber && !claim.claimType.includes('Warehouse') && (
                                                    <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">PO Number</p><p className="font-semibold text-[13px]">{claim.poNumber}</p></div>
                                                )}
                                                {claim.inboundId && (
                                                    <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Inbound ID</p><a href="#" className="font-semibold text-[13px] text-blue-500 hover:underline">{claim.inboundId}</a></div>
                                                )}
                                            </div>
                                        </div>

                                        {claim.reimbursementMatches?.length > 0 && (
                                            <div className="mb-6">
                                                <h5 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground border-b pb-2 mb-4">Reimbursement Details</h5>
                                                {claim.reimbursementMatches.map((m, mIdx) => (
                                                    <div key={mIdx} className="grid grid-cols-4 gap-x-8 gap-y-4 pt-2">
                                                        <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Source</p><p className="font-semibold text-[13px]">Master DB</p></div>
                                                        <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Date</p><p className="font-semibold text-[13px] truncate">{new Date(m.transactionDateTime).toLocaleDateString()}</p></div>
                                                        <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Qty</p><p className="font-semibold text-[13px]">{m.quantity}</p></div>
                                                        <div><p className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Amount</p><p className="font-semibold text-[13px]">${parseFloat(m.netPayable).toFixed(2)}</p></div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <div>
                                            <h5 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground border-b pb-2 mb-4">Actions</h5>
                                            <Button variant="outline" className="h-9" onClick={() => copyClaimDetails(claim)}><ClipboardPaste className="mr-2 h-4 w-4"/>Copy Details for Case</Button>
                                        </div>

                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
      </main>

      {isLoading && (
        <div className="fixed inset-0 bg-background/50 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mb-4"></div>
            <div className="font-medium bg-card px-6 py-2 rounded-full shadow-lg">Processing...</div>
        </div>
      )}
    </div>
  );
}
