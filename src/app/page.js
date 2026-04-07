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
import { FileSpreadsheet, FolderOpen, FileText, SlidersHorizontal, RefreshCcw, Download, UploadCloud, Moon, Sun, Table2, Info } from "lucide-react";
import { useTheme } from "next-themes";
import { processSettlementFile, getMerchants, fetchCrosscheckData } from "@/actions/upload";
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
      
      const newClaims = generatedClaims.map(claim => {
         const normGtin = (claim.gtin || '').replace(/^0+/, '');
         const po = claim.poNumber;
         
         // Find matches in historicalSettlements
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
         
         return { ...claim, reimbursementMatches: matches };
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

  const handleSettlementUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      // Hardcoded merchant detection for now, ideally user inputs it via a modal
      formData.append("merchantName", "Master Settlement Data"); 
      const result = await processSettlementFile(formData);
      if (result.error) toast.error(result.error);
      else {
          toast.success(result.message);
          getMerchants().then(setMerchants);
      }
    } catch (err) {
      toast.error("Upload failed.");
    } finally {
      setIsLoading(false);
    }
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
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      
      {/* Sidebar */}
      <aside className="w-[400px] border-r p-6 flex flex-col gap-6 overflow-y-auto shrink-0 bg-card/50">
        <div className="flex justify-between items-center">
            <h1 className="text-3xl font-extrabold text-blue-600 dark:text-blue-500 tracking-tight">WFS Assistant</h1>
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogTrigger asChild>
                    <Button variant="outline" size="icon" className="rounded-xl"><SlidersHorizontal size={16} /></Button>
                </DialogTrigger>
                <DialogContent>
                    <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
                    <div className="space-y-5 mt-4">
                        <div className="flex justify-between items-center pb-4 border-b">
                            <span className="font-medium text-sm">Update Settlement Data</span>
                            <div className="relative">
                                <Button variant="outline" size="sm" onClick={() => settlementFileInputRef.current?.click()} className="rounded-xl"><Table2 className="mr-2 h-4 w-4"/>Manage DB</Button>
                                <input type="file" ref={settlementFileInputRef} className="hidden" accept=".csv,.xlsx" onChange={handleSettlementUpload} />
                            </div>
                        </div>
                        <div className="flex justify-between items-center border-b pb-4">
                            <Label>Hide Fully Reimbursed Claims</Label>
                            <Switch checked={toggles.hideReimbursed} onCheckedChange={(v) => setToggles({...toggles, hideReimbursed: v})} />
                        </div>
                        <div className="flex justify-between items-center border-b pb-4">
                            <Label>Mark as Investigated on Export</Label>
                            <Switch checked={toggles.markInvestigated} onCheckedChange={(v) => setToggles({...toggles, markInvestigated: v})} />
                        </div>
                        <div className="flex justify-between items-center border-b pb-4">
                            <Label>Show Report Date Range</Label>
                            <Switch checked={toggles.showDate} onCheckedChange={(v) => setToggles({...toggles, showDate: v})} />
                        </div>
                        
                        <div className="border-b pb-4">
                            <Label className="text-blue-500 font-bold">Note Management</Label>
                            <p className="text-xs text-muted-foreground mt-1 mb-3">Enable editing notes for specific categories:</p>
                            <div className="grid grid-cols-2 gap-3">
                                {["Inbound Discrepancy", "Damaged Inbound", "MTR Shortage", "Lost in Warehouse", "Damaged in Warehouse", "Unused Label"].map(cat => (
                                    <div key={cat} className="flex justify-between items-center bg-muted/30 p-2 rounded-lg border">
                                        <span className="text-xs font-medium">{cat}</span>
                                        <Switch className="scale-75" />
                                    </div>
                                ))}
                            </div>
                        </div>
                        
                        <div className="flex justify-between items-center border-b pb-4">
                            <div className="flex flex-col">
                                <Label>Sync Notes</Label>
                                <span className="text-xs text-muted-foreground">(Import/Export)</span>
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" className="h-7 text-xs px-2"><Download className="mr-1.5 h-3 w-3"/>Export</Button>
                                <Button variant="outline" size="sm" className="h-7 text-xs px-2"><UploadCloud className="mr-1.5 h-3 w-3"/>Import</Button>
                            </div>
                        </div>

                        <div className="flex justify-between items-center">
                            <Label>Theme</Label>
                            <div className="flex gap-2 items-center">
                                <Sun size={14}/>
                                <Switch checked={theme === "dark"} onCheckedChange={(v) => setTheme(v ? "dark" : "light")} />
                                <Moon size={14}/>
                            </div>
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
                        className="cursor-pointer py-1.5 transition-all"
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
      <main className="flex-1 flex flex-col relative">
        <header className="px-8 py-6 border-b bg-background/95 backdrop-blur z-10 sticky top-0 flex justify-between items-center">
            <h2 className="text-2xl font-bold tracking-tight">Eligible Claims</h2>
            <div className="space-x-3">
                <Button variant="outline" size="sm"><UploadCloud className="mr-2 h-4 w-4"/>Open All Filtered POs</Button>
                <Button variant="outline" size="sm"><UploadCloud className="mr-2 h-4 w-4"/>Open All Filtered GTINs</Button>
            </div>
        </header>
        
        <div className="p-8 flex-1 overflow-y-auto w-full max-w-5xl">
            {activeClaims.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                    <FileText size={64} className="opacity-20 mb-4" />
                    <h3 className="text-lg font-medium">No Claims Found</h3>
                    <p className="text-sm opacity-70">Use the panel on the left to upload your reports to begin.</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {activeClaims.map((claim, idx) => (
                        <Card key={idx} className="p-0 overflow-hidden hover:shadow-md transition duration-200 border-muted">
                            <div className="p-5 flex justify-between items-start bg-card hover:bg-muted/30">
                                <div>
                                    <div className="flex items-center gap-3">
                                        <h4 className="font-bold text-base">
                                            {claim.gtin ? `GTIN: ${claim.gtin}` : `PO: ${claim.poNumber}`}
                                        </h4>
                                        <Badge variant="outline" className="text-xs bg-background">{claim.claimType}</Badge>
                                        {claim.reimbursementMatches?.length > 0 && (
                                            <Badge className="bg-green-500 hover:bg-green-600 text-white">
                                                Reimbursed ({claim.reimbursementMatches.reduce((acc, m) => acc + (m.quantity || 1), 0)} Qty)
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-sm text-muted-foreground mt-1.5 font-medium">
                                        Discrepancy: <span className="text-foreground tracking-tight">{claim.shortage || claim.damagedUnits || 0} units</span> | {claim.poNumber && `PO: ${claim.poNumber}`}
                                    </p>
                                </div>
                            </div>
                        </Card>
                    ))}
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
