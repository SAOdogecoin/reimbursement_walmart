"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FileSpreadsheet, FolderOpen, FileText, SlidersHorizontal, RefreshCcw,
  Download, UploadCloud, Moon, Sun, Table2, ChevronRight, ChevronDown,
  ClipboardPaste, ExternalLink, Database, SlidersVertical, NotebookPen,
  Palette, X, CheckCircle2, AlertCircle, AlertTriangle, Loader2, Plus
} from "lucide-react";
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
  const [skipDuplicates, setSkipDuplicates] = useState(() => {
    try { const s = localStorage.getItem("skipDuplicates"); return s !== null ? JSON.parse(s) : true; } catch { return true; }
  });
  const [uploadQueue, setUploadQueue] = useState([]); // [{id, file, clientName, clientMode, status, result}]
  const [partnerIdMap, setPartnerIdMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem("partnerIdMap") || "{}"); } catch { return {}; }
  });

  // Claim UI State
  const [selectedClaimKey, setSelectedClaimKey] = useState(null);
  const [investigatedClaims, setInvestigatedClaims] = useState(new Set());
  const [notesEnabled, setNotesEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem("notesEnabled");
      if (saved !== null) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(["Inbound Discrepancy", "Damaged Inbound", "MTR Shortage", "Lost in Warehouse", "Damaged in Warehouse", "Unused Label"]);
  });
  const [claimNotes, setClaimNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("claimNotes") || "{}"); } catch { return {}; }
  });

  const toggleInvestigated = (idx, e) => {
    e?.stopPropagation();
    const next = new Set(investigatedClaims);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setInvestigatedClaims(next);
  };

  const getClaimKey = (claim) => `${claim.claimType}|${claim.poNumber || ''}|${claim.gtin || ''}|${claim.inboundId || ''}`;

  const toggleNoteCategory = (cat) => {
    const next = new Set(notesEnabled);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    setNotesEnabled(next);
    localStorage.setItem("notesEnabled", JSON.stringify([...next]));
  };

  const updateClaimNote = (key, text) => {
    const next = { ...claimNotes, [key]: text };
    setClaimNotes(next);
    localStorage.setItem("claimNotes", JSON.stringify(next));
  };

  const exportNotes = () => {
    const blob = new Blob([JSON.stringify(claimNotes, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "claim-notes.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const importNotesRef = useRef(null);
  const handleImportNotes = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        setClaimNotes(prev => { const next = { ...prev, ...parsed }; localStorage.setItem("claimNotes", JSON.stringify(next)); return next; });
        toast("Notes imported.");
      } catch { toast.error("Failed to parse notes file."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // File References
  const multiFileInputRef = useRef(null);
  const settlementFileInputRef = useRef(null);

  // Filters State
  const [filters, setFilters] = useState(() => {
    const defaults = {
      "Inbound Discrepancy": true,
      "Damaged Inbound": true,
      "MTR Shortage": true,
      "Lost in Warehouse": true,
      "Damaged in Warehouse": true,
      "Unused Label": true,
    };
    try { const s = localStorage.getItem("filters"); return s ? { ...defaults, ...JSON.parse(s) } : defaults; } catch { return defaults; }
  });

  const [toggles, setToggles] = useState(() => {
    const defaults = { hideReimbursed: true, markInvestigated: true, showDate: false };
    try { const s = localStorage.getItem("toggles"); return s ? { ...defaults, ...JSON.parse(s) } : defaults; } catch { return defaults; }
  });

  useEffect(() => {
    getMerchants().then(setMerchants).catch(console.error);
  }, []);

  useEffect(() => { try { localStorage.setItem("toggles", JSON.stringify(toggles)); } catch {} }, [toggles]);
  useEffect(() => { try { localStorage.setItem("filters", JSON.stringify(filters)); } catch {} }, [filters]);
  useEffect(() => { try { localStorage.setItem("skipDuplicates", JSON.stringify(skipDuplicates)); } catch {} }, [skipDuplicates]);

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

    const uniqueClaims = new Map();
    [...generatedClaims, ...claimsAccumulator].forEach(claim => {
      const key = `${claim.claimType}|${claim.inboundId || claim.poNumber || claim.gtin}`;
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
      const merchantArg = selectedMerchant === "all" ? "" : selectedMerchant;
      const historicalSettlements = await fetchCrosscheckData(merchantArg);

      const allGtins = [...new Set(generatedClaims.map(c => (c.gtin || "").replace(/^0+/, "")).filter(Boolean))];
      let caseStatusList = [];
      try {
        caseStatusList = await fetchCaseStatuses(allGtins);
      } catch (e) {
        console.warn("CaseStatus unavailable:", e?.message);
      }
      const caseStatusByGtin = new Map();
      caseStatusList.forEach(cs => {
        if (!caseStatusByGtin.has(cs.gtin)) caseStatusByGtin.set(cs.gtin, []);
        caseStatusByGtin.get(cs.gtin).push(cs);
      });

      const newClaims = generatedClaims.map(claim => {
        const normGtin = (claim.gtin || "").replace(/^0+/, "");
        const po = claim.poNumber;

        const matches = historicalSettlements.filter(s => {
          const sGtin = (s.partnerGtin || "").replace(/^0+/, "");
          const sPo = s.walmartPoNumber;
          const isRefund = s.transactionType === "Refund";
          if (["Inbound Discrepancy", "Damaged Inbound", "MTR Shortage"].includes(claim.claimType))
            return sPo === po && sGtin === normGtin && isRefund && s.reasonCode.toLowerCase().includes("inbound");
          if (claim.claimType === "Lost in Warehouse") return sGtin === normGtin && s.transactionType === "LostInventory";
          if (claim.claimType === "Damaged in Warehouse") return sGtin === normGtin && s.transactionType === "DamageInWarehouse";
          if (claim.claimType === "Unused Label") return sPo === po && s.transactionType === "InboundTransportationFee";
          return false;
        });

        const caseStatusMatches = caseStatusByGtin.get(normGtin) || [];
        return { ...claim, reimbursementMatches: matches, caseStatusMatches };
      });

      setGeneratedClaims(newClaims);
      toast.success("Crosscheck complete");
    } catch (err) {
      console.error(err);
      toast.error("Crosscheck failed.");
    } finally {
      setIsLoading(false);
    }
  };

  // --- Upload Queue ---
  const detectClientName = (file) => {
    const base = file.name.replace(/\.(csv|xlsx)$/i, "");
    const match = base.match(/Master Data - (.+)$/i);
    return match ? match[1].trim() : base;
  };

  const handleSettlementFilesSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const newItems = files.map(file => {
      const detected = detectClientName(file);
      const isKnown = merchants.includes(detected);
      return {
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        clientName: detected,
        clientMode: isKnown ? "existing" : "new",
        status: "pending",
        result: null,
      };
    });
    setUploadQueue(prev => [...prev, ...newItems]);
    e.target.value = "";
  };

  const removeFromQueue = (id) => setUploadQueue(prev => prev.filter(item => item.id !== id));

  const updateQueueItemClient = (id, clientName) =>
    setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, clientName } : item));

  const uploadQueueItem = async (item) => {
    const clientName = item.clientName.trim();
    if (!clientName) return { ...item, status: "error", result: { error: "No client name" } };

    setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: "uploading" } : i));
    try {
      const formData = new FormData();
      formData.append("file", item.file);
      formData.append("merchantName", clientName);
      const result = await processSettlementFile(formData);
      const status = result.error ? "error" : "done";
      setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status, result } : i));
      // Only toast on success — errors and warnings shown inline in the queue row
      if (!result.error) toast.success(`${clientName} — ${result.added} rows added`);
      return { ...item, status, result };
    } catch (err) {
      const msg = err?.message || "Network or server error";
      setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: "error", result: { error: msg } } : i));
    }
  };

  const handleUploadAll = async () => {
    const pending = uploadQueue.filter(i => i.status === "pending" || i.status === "error");
    if (!pending.length) return;
    setIsLoading(true);
    for (const item of pending) await uploadQueueItem(item);
    getMerchants().then(setMerchants);
    setIsLoading(false);
  };

  // --- Helpers ---
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
    toast.success(`${pos.length} PO numbers copied`);
  };

  const copyClaim = (claim) => {
    const value = claim.claimType.includes("Warehouse") ? claim.gtin : (claim.poNumber || claim.gtin || claim.inboundId);
    if (value) navigator.clipboard.writeText(value);
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
    toast.success("Claim details copied");
  };

  const activeClaims = generatedClaims.filter(c => {
    if (!filters[c.claimType]) return false;
    const term = searchQuery.toLowerCase();
    if (term && !((c.gtin || "").toLowerCase().includes(term) || (c.poNumber || "").toLowerCase().includes(term) || (c.inboundId || "").toLowerCase().includes(term))) return false;
    if (toggles.hideReimbursed && c.reimbursementMatches?.length > 0) {
      const totalReimbursed = c.reimbursementMatches.reduce((acc, m) => acc + (m.quantity || 1), 0);
      if (totalReimbursed >= (c.shortage || c.damagedUnits || 0)) return false;
    }
    return true;
  });

  const selectedClaim = selectedClaimKey ? generatedClaims.find(c => getClaimKey(c) === selectedClaimKey) ?? null : null;

  const getCount = (type) => generatedClaims.filter(c => c.claimType === type).length;

  const CATEGORIES = ["Inbound Discrepancy", "Damaged Inbound", "MTR Shortage", "Lost in Warehouse", "Damaged in Warehouse", "Unused Label"];

  // Shared style tokens
  const sectionLabel = "text-[10px] font-bold text-slate-400 uppercase tracking-widest";
  const panel = "bg-white dark:bg-card border border-slate-100 dark:border-border rounded-xl p-5";
  const fieldLabel = "text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5";

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-background overflow-hidden font-sans text-sm">

      {/* ── Left Sidebar ── */}
      <aside className="w-[390px] border-r border-slate-100 dark:border-border flex flex-col gap-4 overflow-y-auto shrink-0 bg-slate-50 dark:bg-muted/10 p-5">

        {/* Header */}
        <div className="flex justify-between items-center py-1">
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">WFS Assistant</h1>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mt-0.5">Claim Filing</p>
          </div>
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogTrigger asChild>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card text-slate-500 hover:text-slate-900 hover:border-slate-300 transition-colors">
                <SlidersHorizontal size={14} />
              </button>
            </DialogTrigger>

            {/* ── Settings Dialog ── */}
            <DialogContent className="w-[820px] max-w-[calc(100vw-2rem)] sm:max-w-[820px] p-0 gap-0 overflow-hidden">
              <div className="flex h-[580px]">
                {/* Settings Nav */}
                <nav className="w-52 border-r border-slate-100 dark:border-border bg-slate-50 dark:bg-muted/20 flex flex-col p-3 gap-0.5 shrink-0">
                  <p className={`${sectionLabel} px-3 py-2.5`}>Settings</p>
                  {[
                    { id: "database", label: "Database", icon: Database },
                    { id: "preferences", label: "Preferences", icon: SlidersVertical },
                    { id: "notes", label: "Notes", icon: NotebookPen },
                    { id: "appearance", label: "Appearance", icon: Palette },
                  ].map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setSettingsTab(id)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left w-full ${settingsTab === id ? "bg-white dark:bg-background shadow-sm text-slate-900 dark:text-foreground border border-slate-100 dark:border-border" : "text-slate-500 hover:text-slate-800 hover:bg-white/60 dark:hover:bg-muted/40"}`}
                    >
                      <Icon size={14} className={settingsTab === id ? "text-slate-700" : "text-slate-400"} />
                      {label}
                    </button>
                  ))}
                </nav>

                {/* Settings Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-card">

                  {/* DATABASE TAB */}
                  {settingsTab === "database" && (
                    <div className="space-y-6">
                      <div>
                        <h2 className="font-semibold text-base text-slate-900 dark:text-foreground mb-0.5">Upload Settlement Files</h2>
                        <p className="text-xs text-slate-400 mb-5">Select one or more CSVs. Client names are auto-detected from filenames.</p>

                        {/* Add files button */}
                        <button
                          onClick={() => settlementFileInputRef.current?.click()}
                          className="w-full flex items-center justify-center gap-2 h-9 px-4 text-xs font-semibold rounded-lg border-2 border-dashed border-slate-200 dark:border-border text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors mb-3"
                        >
                          <Plus size={13} /> Add Files to Queue
                        </button>
                        <input type="file" ref={settlementFileInputRef} className="hidden" accept=".csv,.xlsx" multiple onChange={handleSettlementFilesSelect} />

                        {/* Queue */}
                        {uploadQueue.length > 0 && (
                          <div className="border border-slate-100 dark:border-border rounded-lg overflow-hidden mb-3">
                            {uploadQueue.map((item, i) => (
                              <div key={item.id} className={`flex items-center gap-2.5 px-3 py-2.5 ${i !== 0 ? "border-t border-slate-50 dark:border-border" : ""}`}>
                                {/* Status icon */}
                                <div className="shrink-0 w-4 flex justify-center">
                                  {item.status === "done"      && <CheckCircle2 size={13} className="text-emerald-500" />}
                                  {item.status === "error"     && <AlertCircle  size={13} className="text-red-400" />}
                                  {item.status === "uploading" && <Loader2      size={13} className="animate-spin text-slate-400" />}
                                  {item.status === "pending"   && <div className="w-1.5 h-1.5 rounded-full bg-slate-300" />}
                                </div>

                                {/* Filename + client name select/input */}
                                <div className="flex-1 min-w-0">
                                  <p className="text-[11px] text-slate-400 truncate leading-none mb-1">{item.file.name}</p>
                                  {item.status === "uploading" || item.status === "done" ? (
                                    <p className="text-xs font-semibold text-slate-800 dark:text-foreground truncate">{item.clientName}</p>
                                  ) : (
                                    <div className="flex items-center gap-1.5">
                                      <select
                                        className="text-[11px] font-medium text-slate-600 bg-slate-50 dark:bg-muted border border-slate-200 dark:border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-slate-300 shrink-0 max-w-[110px]"
                                        value={item.clientMode === "existing" && merchants.includes(item.clientName) ? item.clientName : "__new__"}
                                        onChange={e => {
                                          const val = e.target.value;
                                          if (val === "__new__") {
                                            setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, clientMode: "new", clientName: "" } : i));
                                          } else {
                                            setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, clientMode: "existing", clientName: val } : i));
                                          }
                                        }}
                                      >
                                        {merchants.map(m => <option key={m} value={m}>{m}</option>)}
                                        <option value="__new__">+ New client…</option>
                                      </select>
                                      {(item.clientMode === "new" || !merchants.includes(item.clientName)) && (
                                        <input
                                          className="text-[11px] font-semibold text-slate-800 dark:text-foreground bg-slate-50 dark:bg-muted border border-slate-200 dark:border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-slate-300 min-w-0 flex-1"
                                          value={item.clientName}
                                          onChange={e => updateQueueItemClient(item.id, e.target.value)}
                                          placeholder="New client name…"
                                        />
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Rows added */}
                                {item.status === "done" && item.result && !item.result.error && (
                                  <span className="text-[10px] text-emerald-600 font-bold shrink-0">+{item.result.added}</span>
                                )}

                                {/* Warning tooltip (orange !) — shown on done rows with warnings */}
                                {item.result?.warnings?.length > 0 && (
                                  <div className="relative group/warn shrink-0">
                                    <AlertTriangle size={13} className="text-orange-400 cursor-help" />
                                    <div className="absolute right-0 bottom-full mb-2 w-72 bg-slate-900 text-white text-[11px] leading-relaxed rounded-lg px-3 py-2.5 shadow-xl hidden group-hover/warn:block z-50 pointer-events-none">
                                      {item.result.warnings[0]}
                                    </div>
                                  </div>
                                )}

                                {/* Error tooltip (red !) — inline, no toast */}
                                {item.result?.error && (
                                  <div className="relative group/err shrink-0">
                                    <AlertCircle size={13} className="text-red-400 cursor-help" />
                                    <div className="absolute right-0 bottom-full mb-2 w-72 bg-slate-900 text-white text-[11px] leading-relaxed rounded-lg px-3 py-2.5 shadow-xl hidden group-hover/err:block z-50 pointer-events-none">
                                      {item.result.error}
                                    </div>
                                  </div>
                                )}

                                {/* Remove */}
                                {item.status !== "uploading" && (
                                  <button onClick={() => removeFromQueue(item.id)} className="shrink-0 text-slate-200 hover:text-slate-500 transition-colors ml-0.5">
                                    <X size={11} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Checkbox checked={skipDuplicates} onCheckedChange={setSkipDuplicates} id="skip-dup" className="w-3.5 h-3.5" />
                            <Label htmlFor="skip-dup" className="text-[11px] text-slate-500 cursor-pointer">Skip duplicates</Label>
                          </div>
                          <div className="flex-1" />
                          {uploadQueue.some(i => i.status === "done") && (
                            <button onClick={() => setUploadQueue(prev => prev.filter(i => i.status !== "done"))} className="text-[11px] text-slate-400 hover:text-slate-600">Clear done</button>
                          )}
                          <button
                            onClick={handleUploadAll}
                            disabled={isLoading || !uploadQueue.some(i => i.status === "pending" || i.status === "error")}
                            className="inline-flex items-center gap-1.5 h-8 px-4 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-foreground text-white dark:text-background hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            <UploadCloud size={12} /> Upload All
                          </button>
                        </div>
                      </div>

                      {/* Partner ID Mapping */}
                      <div className="border-t border-slate-100 dark:border-border pt-5">
                        <h3 className="font-semibold text-sm text-slate-900 dark:text-foreground mb-0.5">Partner ID Mapping</h3>
                        <p className="text-xs text-slate-400 mb-3">Fallback client detection via Partner ID column.</p>
                        <div className="space-y-1 max-h-32 overflow-y-auto border border-slate-100 dark:border-border rounded-lg p-2 mb-3">
                          {Object.keys(partnerIdMap).length === 0 && (
                            <p className="text-[11px] text-slate-400 text-center py-2">No mappings yet</p>
                          )}
                          {Object.entries(partnerIdMap).map(([pid, name]) => (
                            <div key={pid} className="flex items-center gap-2 text-xs px-1 py-0.5">
                              <span className="truncate flex-1 font-medium text-slate-700">{name}</span>
                              <span className="font-mono text-slate-400 shrink-0 text-[11px]">{pid}</span>
                              <button className="text-slate-300 hover:text-red-400 shrink-0" onClick={() => { const m = { ...partnerIdMap }; delete m[pid]; savePartnerIdMap(m); }}>×</button>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input id="new-pid-name" placeholder="Merchant name" className="flex-1 h-8 px-2.5 text-xs border border-slate-200 dark:border-border rounded-lg bg-slate-50 dark:bg-muted focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input id="new-pid-id" placeholder="Partner ID" className="w-32 h-8 px-2.5 text-xs font-mono border border-slate-200 dark:border-border rounded-lg bg-slate-50 dark:bg-muted focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <button className="h-8 px-3 text-xs font-semibold rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors" onClick={() => {
                            const name = document.getElementById("new-pid-name").value.trim();
                            const pid = document.getElementById("new-pid-id").value.trim();
                            if (name && pid) { savePartnerIdMap({ ...partnerIdMap, [pid]: name }); document.getElementById("new-pid-name").value = ""; document.getElementById("new-pid-id").value = ""; }
                          }}>Add</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* PREFERENCES TAB */}
                  {settingsTab === "preferences" && (
                    <div>
                      <h2 className="font-semibold text-base text-slate-900 dark:text-foreground mb-5">Preferences</h2>
                      {[
                        { key: "hideReimbursed", label: "Hide Fully Reimbursed Claims", desc: "Claims where reimbursed qty ≥ shortage are hidden." },
                        { key: "markInvestigated", label: "Mark as Investigated on Export", desc: "Checked claims are marked when exporting." },
                        { key: "showDate", label: "Show Report Date Range", desc: "Display the date range of uploaded reports." },
                      ].map(({ key, label, desc }) => (
                        <div key={key} className="flex items-start justify-between py-4 border-b border-slate-50 dark:border-border last:border-b-0 gap-4">
                          <div>
                            <p className="text-sm font-medium text-slate-800 dark:text-foreground">{label}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{desc}</p>
                          </div>
                          <Switch checked={toggles[key]} onCheckedChange={(v) => setToggles({ ...toggles, [key]: v })} className="shrink-0 mt-0.5" />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* NOTES TAB */}
                  {settingsTab === "notes" && (
                    <div className="space-y-6">
                      <div>
                        <h2 className="font-semibold text-base text-slate-900 dark:text-foreground mb-0.5">Note Management</h2>
                        <p className="text-xs text-slate-400 mb-4">Enable note fields per claim category.</p>
                        <div className="grid grid-cols-2 gap-2">
                          {CATEGORIES.map(cat => (
                            <div key={cat} className="flex justify-between items-center bg-slate-50 dark:bg-muted p-3 rounded-lg border border-slate-100 dark:border-border">
                              <span className="text-[11px] font-medium text-slate-700 dark:text-foreground leading-tight pr-2">{cat}</span>
                              <Switch checked={notesEnabled.has(cat)} onCheckedChange={() => toggleNoteCategory(cat)} className="scale-75 origin-right shrink-0" />
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-slate-100 dark:border-border pt-5">
                        <h3 className="font-semibold text-sm text-slate-900 dark:text-foreground mb-0.5">Sync Notes</h3>
                        <p className="text-xs text-slate-400 mb-3">Import or export all notes as a JSON file.</p>
                        <div className="flex gap-2">
                          <button onClick={exportNotes} className="inline-flex items-center h-8 px-3 text-xs font-medium rounded-lg border border-slate-200 dark:border-border hover:bg-slate-50 transition-colors gap-1.5"><Download size={12} />Export Notes</button>
                          <button onClick={() => importNotesRef.current?.click()} className="inline-flex items-center h-8 px-3 text-xs font-medium rounded-lg border border-slate-200 dark:border-border hover:bg-slate-50 transition-colors gap-1.5"><UploadCloud size={12} />Import Notes</button>
                          <input type="file" ref={importNotesRef} className="hidden" accept=".json" onChange={handleImportNotes} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* APPEARANCE TAB */}
                  {settingsTab === "appearance" && (
                    <div>
                      <h2 className="font-semibold text-base text-slate-900 dark:text-foreground mb-5">Appearance</h2>
                      <div className="flex items-center justify-between py-4 border-b border-slate-50 dark:border-border">
                        <div>
                          <p className="text-sm font-medium text-slate-800 dark:text-foreground">Theme</p>
                          <p className="text-xs text-slate-400 mt-0.5">Switch between light and dark mode.</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Sun size={14} className="text-slate-400" />
                          <Switch checked={theme === "dark"} onCheckedChange={(v) => setTheme(v ? "dark" : "light")} />
                          <Moon size={14} className="text-slate-400" />
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* ── Audit Upload Card ── */}
        <div
          className={`${panel} flex flex-col items-center justify-center text-center gap-4 border-2 border-dashed cursor-pointer hover:border-slate-300 transition-colors`}
          onClick={() => multiFileInputRef.current?.click()}
        >
          <div className="w-11 h-11 rounded-xl bg-slate-50 dark:bg-muted border border-slate-100 dark:border-border flex items-center justify-center">
            <FileSpreadsheet size={22} className="text-slate-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-700 dark:text-foreground">Drop audit reports here</p>
            <p className="text-[11px] text-slate-400 mt-0.5">InboundReceipt or Reconciliation files</p>
          </div>
          <div className="flex gap-2 w-full" onClick={e => e.stopPropagation()}>
            <button className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-foreground text-white dark:text-background hover:bg-slate-700 transition-colors" onClick={() => multiFileInputRef.current?.click()}>
              <FolderOpen size={12} /> Select Files
            </button>
            <button className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 text-xs font-semibold rounded-lg border border-slate-200 dark:border-border text-slate-600 hover:bg-slate-50 transition-colors" onClick={() => { setGeneratedClaims([]); setInboundFiles([]); setReconFiles([]); }}>
              <FileText size={12} /> New Audit
            </button>
            <input type="file" ref={multiFileInputRef} multiple className="hidden" accept=".csv,.xlsx" onChange={e => handleAuditFiles(e.target.files)} />
          </div>
          {(inboundFiles.length > 0 || reconFiles.length > 0) && (
            <div className="w-full text-left space-y-1.5">
              {inboundFiles.length > 0 && (
                <div className="bg-slate-50 dark:bg-muted rounded-lg border border-slate-100 dark:border-border p-2.5">
                  <p className={`${sectionLabel} mb-1`}>Inbound Receipts</p>
                  {inboundFiles.map(f => <p key={f} className="text-[11px] text-slate-600 dark:text-foreground truncate">{f}</p>)}
                </div>
              )}
              {reconFiles.length > 0 && (
                <div className="bg-slate-50 dark:bg-muted rounded-lg border border-slate-100 dark:border-border p-2.5">
                  <p className={`${sectionLabel} mb-1`}>Reconciliation</p>
                  {reconFiles.map(f => <p key={f} className="text-[11px] text-slate-600 dark:text-foreground truncate">{f}</p>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Crosscheck ── */}
        <div className={panel}>
          <p className={fieldLabel}>Merchant</p>
          <Select value={selectedMerchant} onValueChange={setSelectedMerchant}>
            <SelectTrigger className="bg-slate-50 dark:bg-muted border-slate-200 dark:border-border text-sm">
              <SelectValue placeholder="Select database target..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {merchants.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <button
            className="w-full mt-3 inline-flex items-center justify-center gap-2 h-9 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-foreground text-white dark:text-background hover:bg-slate-700 disabled:opacity-40 transition-colors"
            onClick={handleCrosscheck}
            disabled={isLoading}
          >
            <RefreshCcw size={13} /> Run Crosscheck
          </button>
        </div>

        {/* ── Filters ── */}
        <div className={`${panel} flex-1`}>
          <p className={`${fieldLabel} mb-3`}>Filters</p>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setFilters(prev => ({ ...prev, [cat]: !prev[cat] }))}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${filters[cat] ? "bg-slate-900 dark:bg-foreground text-white dark:text-background border-slate-900 dark:border-foreground" : "bg-white dark:bg-muted text-slate-500 border-slate-200 dark:border-border hover:border-slate-400"}`}
              >
                {cat}
                <span className={`text-[10px] font-bold ${filters[cat] ? "opacity-60" : "text-slate-400"}`}>{getCount(cat)}</span>
              </button>
            ))}
          </div>
          <Input
            placeholder="Search GTIN, PO, Inbound ID..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-slate-50 dark:bg-muted border-slate-200 dark:border-border text-sm h-8"
          />
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className="flex-1 flex flex-col relative w-full h-full bg-white dark:bg-background overflow-hidden">

        {/* Header */}
        <header className="px-8 py-4 border-b border-slate-100 dark:border-border bg-white dark:bg-background z-10 sticky top-0 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-foreground tracking-tight">Eligible Claims</h2>
            <p className="text-[11px] text-slate-400 mt-0.5">{activeClaims.length} claim{activeClaims.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold rounded-lg border border-slate-200 dark:border-border text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors" onClick={openAllPos}>
              <ExternalLink size={12} /> Open All POs
            </button>
            <button className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold rounded-lg border border-slate-200 dark:border-border text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors" onClick={openAllGtins}>
              <ExternalLink size={12} /> Open All GTINs
            </button>
          </div>
        </header>

        {/* Claims List */}
        <div className="flex-1 overflow-y-auto w-full">
          {activeClaims.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center p-8">
              <div className="w-14 h-14 rounded-2xl bg-slate-50 dark:bg-muted border border-slate-100 dark:border-border flex items-center justify-center mb-4">
                <FileText size={24} className="text-slate-300" />
              </div>
              <h3 className="text-sm font-semibold text-slate-600 dark:text-foreground mb-1">No claims yet</h3>
              <p className="text-xs text-slate-400">Upload InboundReceipt or Reconciliation files from the left panel.</p>
            </div>
          ) : (
            <div className="w-full pb-12">
              {CATEGORIES
                .map(type => ({ type, items: activeClaims.map((claim, idx) => ({ claim, idx })).filter(({ claim }) => claim.claimType === type) }))
                .filter(g => g.items.length > 0)
                .map(({ type, items }) => (
                  <div key={type} className="w-full">
                    {/* Sticky category header */}
                    <div className="sticky top-0 z-10 bg-white/95 dark:bg-background/95 backdrop-blur border-b border-slate-100 dark:border-border px-8 py-2.5 flex items-center gap-2.5">
                      <span className="w-1 h-3.5 rounded-full bg-slate-900 dark:bg-foreground inline-block shrink-0" />
                      <span className={`${sectionLabel}`}>{type}</span>
                      <span className="text-[10px] font-bold text-slate-300 dark:text-muted-foreground">{items.length}</span>
                    </div>

                    {/* Claim rows */}
                    <div>
                      {items.map(({ claim, idx }) => {
                        const isInvestigated = investigatedClaims.has(idx);
                        return (
                          <div key={idx} className={`w-full border-b border-slate-50 dark:border-border last:border-b-0 transition-opacity ${isInvestigated ? "opacity-40" : ""}`}>
                            <div
                              className={`px-8 py-3.5 flex items-center justify-between group cursor-pointer transition-colors ${selectedClaimKey === getClaimKey(claim) ? "bg-slate-50/80 dark:bg-muted/20" : "hover:bg-slate-50/60 dark:hover:bg-muted/10"}`}
                              onClick={() => setSelectedClaimKey(k => k === getClaimKey(claim) ? null : getClaimKey(claim))}
                            >
                              <div className="flex items-center gap-3.5 flex-1 min-w-0">
                                <div onClick={e => e.stopPropagation()}>
                                  <Checkbox checked={isInvestigated} onCheckedChange={() => toggleInvestigated(idx)} className="w-3.5 h-3.5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <h4 className={`font-semibold text-[13px] truncate ${isInvestigated ? "line-through text-slate-400" : "text-slate-900 dark:text-foreground"}`}>
                                      {claim.claimType.includes("Warehouse") ? `GTIN: ${claim.gtin}` : claim.poNumber ? `PO: ${claim.poNumber}` : `Inbound: ${claim.inboundId}`}
                                    </h4>
                                    <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                      {claimNotes[getClaimKey(claim)] && (
                                        <span className="group-hover:hidden inline-flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded-md bg-blue-50 text-blue-600 border border-blue-100 max-w-[120px]">
                                          <NotebookPen size={9} className="shrink-0" />
                                          <span className="truncate">{claimNotes[getClaimKey(claim)]}</span>
                                        </span>
                                      )}
                                      <div className="invisible group-hover:visible opacity-0 group-hover:opacity-100 focus-within:visible focus-within:opacity-100 flex items-center gap-1 transition-all">
                                        <button className="h-5 px-2 text-[10px] font-semibold rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors" onClick={() => { const q = claim.gtin || claim.poNumber || claim.inboundId; if (q) window.open(`https://www.walmart.com/search?q=${q}`, "_blank"); }}>Open</button>
                                        <button className="h-5 px-2 text-[10px] font-semibold rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors" onClick={() => copyClaim(claim)}>Copy</button>
                                        <input
                                          type="text"
                                          className="h-5 w-28 px-2 text-[10px] rounded-md border border-slate-200 dark:border-border bg-white dark:bg-muted text-slate-600 dark:text-foreground placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-300"
                                          placeholder="Add note..."
                                          value={claimNotes[getClaimKey(claim)] || ""}
                                          onChange={e => updateClaimNote(getClaimKey(claim), e.target.value)}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                  <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                                    {claim.claimType === "Lost in Warehouse" ? "Net Loss" : claim.claimType === "Damaged in Warehouse" ? "Damaged" : "Discrepancy"}:
                                    <span className="font-semibold text-slate-600 dark:text-slate-300 ml-1">{claim.shortage || claim.damagedUnits || 0} units</span>
                                    {claim.gtin && !claim.claimType.includes("Warehouse") ? ` · GTIN ${claim.gtin}` : ""}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0 ml-4">
                                {claim.reimbursementMatches?.length > 0 && (
                                  <span className="inline-flex items-center bg-emerald-50 text-emerald-700 border border-emerald-100 text-[10px] font-bold px-2 py-0.5 rounded-full">
                                    Reimbursed · {claim.reimbursementMatches.reduce((a, m) => a + (m.quantity || 1), 0)}
                                  </span>
                                )}
                                {claim.caseStatusMatches?.length > 0 && (() => {
                                  const declined = claim.caseStatusMatches.find(c => c.status === "Declined");
                                  const cs = declined || claim.caseStatusMatches[0];
                                  return cs.status === "Declined"
                                    ? <span className="inline-flex items-center bg-orange-50 text-orange-700 border border-orange-100 text-[10px] font-bold px-2 py-0.5 rounded-full">Case Declined</span>
                                    : <span className="inline-flex items-center bg-amber-50 text-amber-700 border border-amber-100 text-[10px] font-bold px-2 py-0.5 rounded-full">Case Pending</span>;
                                })()}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* ── Detail Side Panel ── */}
        <div className={`absolute right-0 top-0 bottom-0 w-[400px] bg-white dark:bg-card border-l border-slate-100 dark:border-border shadow-xl z-20 flex flex-col transition-transform duration-300 ease-in-out ${selectedClaim ? "translate-x-0" : "translate-x-full"}`}>
          {selectedClaim && (<>
            {/* Panel header */}
            <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-border shrink-0">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className={sectionLabel + " mb-1"}>{selectedClaim.claimType}</p>
                  <h3 className="font-bold text-base text-slate-900 dark:text-foreground truncate">
                    {selectedClaim.claimType.includes("Warehouse") ? selectedClaim.gtin : (selectedClaim.poNumber || selectedClaim.inboundId || selectedClaim.gtin)}
                  </h3>
                </div>
                <button onClick={() => setSelectedClaimKey(null)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 dark:border-border text-slate-400 hover:text-slate-700 transition-colors shrink-0 mt-0.5">
                  <X size={13} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {selectedClaim.reimbursementMatches?.length > 0 && (
                  <span className="inline-flex items-center bg-emerald-50 text-emerald-700 border border-emerald-100 text-[10px] font-bold px-2 py-0.5 rounded-full">
                    Reimbursed · {selectedClaim.reimbursementMatches.reduce((a, m) => a + (m.quantity || 1), 0)}
                  </span>
                )}
                {selectedClaim.caseStatusMatches?.length > 0 && (() => {
                  const declined = selectedClaim.caseStatusMatches.find(c => c.status === "Declined");
                  const cs = declined || selectedClaim.caseStatusMatches[0];
                  return cs.status === "Declined"
                    ? <span className="inline-flex items-center bg-orange-50 text-orange-700 border border-orange-100 text-[10px] font-bold px-2 py-0.5 rounded-full">Case Declined</span>
                    : <span className="inline-flex items-center bg-amber-50 text-amber-700 border border-amber-100 text-[10px] font-bold px-2 py-0.5 rounded-full">Case Pending</span>;
                })()}
              </div>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

              {/* Units & Values */}
              <div>
                <p className={`${sectionLabel} border-b border-slate-100 dark:border-border pb-2 mb-4`}>Units & Values</p>
                <div className="grid grid-cols-3 gap-x-6 gap-y-3">
                  {selectedClaim.claimType === "Lost in Warehouse" ? (<>
                    <div><p className={sectionLabel + " mb-1"}>Lost</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.lostUnits || 0}</p></div>
                    <div><p className={sectionLabel + " mb-1"}>Found</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.foundUnits || 0}</p></div>
                    <div><p className={sectionLabel + " mb-1"}>Net Loss</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.shortage || 0}</p></div>
                  </>) : selectedClaim.claimType === "Damaged in Warehouse" ? (
                    <div><p className={sectionLabel + " mb-1"}>Damaged</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.damagedUnits || 0}</p></div>
                  ) : (<>
                    <div><p className={sectionLabel + " mb-1"}>Expected</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.expectedUnits || 0}</p></div>
                    <div><p className={sectionLabel + " mb-1"}>Received</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.receivedUnits || 0}</p></div>
                    <div><p className={sectionLabel + " mb-1"}>Shortage</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.shortage || 0}</p></div>
                  </>)}
                </div>
              </div>

              {/* Identifiers */}
              <div>
                <p className={`${sectionLabel} border-b border-slate-100 dark:border-border pb-2 mb-4`}>Identifiers</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  {selectedClaim.gtin && <div><p className={sectionLabel + " mb-1"}>GTIN</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.gtin}</p></div>}
                  {selectedClaim.sku && <div><p className={sectionLabel + " mb-1"}>SKU</p><p className="font-bold text-sm text-slate-900 dark:text-foreground truncate">{selectedClaim.sku}</p></div>}
                  {selectedClaim.poNumber && !selectedClaim.claimType.includes("Warehouse") && <div><p className={sectionLabel + " mb-1"}>PO Number</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.poNumber}</p></div>}
                  {selectedClaim.inboundId && <div><p className={sectionLabel + " mb-1"}>Inbound ID</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{selectedClaim.inboundId}</p></div>}
                </div>
              </div>

              {/* Reimbursement Details */}
              {selectedClaim.reimbursementMatches?.length > 0 && (
                <div>
                  <p className={`${sectionLabel} border-b border-slate-100 dark:border-border pb-2 mb-4`}>Reimbursement Details</p>
                  {selectedClaim.reimbursementMatches.map((m, mIdx) => (
                    <div key={mIdx} className="grid grid-cols-2 gap-x-6 gap-y-3 pb-3 last:pb-0">
                      <div><p className={sectionLabel + " mb-1"}>Date</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{new Date(m.transactionDateTime).toLocaleDateString()}</p></div>
                      <div><p className={sectionLabel + " mb-1"}>Qty</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">{m.quantity}</p></div>
                      <div><p className={sectionLabel + " mb-1"}>Amount</p><p className="font-bold text-sm text-emerald-600">${parseFloat(m.netPayable).toFixed(2)}</p></div>
                      <div><p className={sectionLabel + " mb-1"}>Source</p><p className="font-bold text-sm text-slate-900 dark:text-foreground">Master DB</p></div>
                    </div>
                  ))}
                </div>
              )}

              {/* Note */}
              <div>
                <p className={`${sectionLabel} border-b border-slate-100 dark:border-border pb-2 mb-3`}>Note</p>
                <textarea
                  className="w-full text-xs border border-slate-200 dark:border-border rounded-lg p-3 bg-slate-50 dark:bg-muted resize-none focus:outline-none focus:ring-1 focus:ring-slate-300 placeholder:text-slate-300"
                  rows={3}
                  placeholder="Add a note for this claim..."
                  value={claimNotes[getClaimKey(selectedClaim)] || ""}
                  onChange={e => updateClaimNote(getClaimKey(selectedClaim), e.target.value)}
                />
              </div>

              {/* Actions */}
              <div>
                <p className={`${sectionLabel} border-b border-slate-100 dark:border-border pb-2 mb-3`}>Actions</p>
                <button className="inline-flex items-center gap-1.5 h-8 px-4 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-foreground text-white dark:text-background hover:bg-slate-700 transition-colors" onClick={() => copyClaimDetails(selectedClaim)}>
                  <ClipboardPaste size={12} /> Copy Details for Case
                </button>
              </div>

            </div>
          </>)}
        </div>
      </main>

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-white/60 dark:bg-background/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
          <div className="animate-spin rounded-full h-9 w-9 border-2 border-slate-100 border-t-slate-900 mb-4" />
          <p className="text-xs font-semibold text-slate-600 dark:text-foreground bg-white dark:bg-card px-5 py-2 rounded-full border border-slate-100 dark:border-border shadow-sm">Processing...</p>
        </div>
      )}
    </div>
  );
}
